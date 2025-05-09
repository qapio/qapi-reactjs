import {Observable, of, concatMap, flatMap, filter, map, scan} from "rxjs";

type ChunkDto = {
    Bytes: string;
    FirstChunk: boolean;
    LastChunk: boolean;
}


function assembleChunks(collectedChunks) {

    // Calculate the total buffer size
    const bufferSize = collectedChunks.reduce((acc, chunk) => acc + chunk.length, 0);

    // Create a byte array to store the assembled data
    const bytesData = new Uint8Array(bufferSize);

    // Fill the byte array with the chunk data
    let curIndex = 0;
    collectedChunks.forEach(chunk => {
        bytesData.set(chunk, curIndex);
        curIndex += chunk.length;
    });

    // Convert the byte array to a UTF-8 string and parse it as JSON

    const decodedString = new TextDecoder("utf-8").decode(bytesData);

    return JSON.parse(decodedString);
}


function assembler(chunk: Observable<ChunkDto>) {
    function partition(acc, i: ChunkDto) {
        if (i.firstChunk === true && i.lastChunk === true) {
            return [[], [i]];
        }

        acc[0].push(i);

        if (i.firstChunk === true) {
            return [acc[0], null];
        }

        if (i.lastChunk === true) {
            const s = [...acc[0]];  // Clone the accumulated array
            return [[], s];
        }

        return acc;
    }
    return chunk.pipe(map(x => x.split("\n")[2]), map((t) => JSON.parse(t.replace("data: ", ""))),scan(partition, [[], null]), filter(x => x[1] !== null), map(x => assembleChunks(x[1].map(y => {
        const data = Buffer.from(y.bytes, "base64");
        return data;
    }))));
}

export class Qapi {
    constructor(private readonly host: string, private readonly endpoint?: string) {

    }

    public async Query(expression: string): Promise<any> {

        let url = `${this.host}/query/${encodeURIComponent(expression)}`;

        if (this.endpoint) {
            url = `${this.host}/query/${this.endpoint}.${encodeURIComponent(expression)}`;
        }

        const data = await fetch(url)

        return await data.json();
    }

    public Source(expression: string) {
        let url = `${this.host}/source/${encodeURIComponent(expression)}`;

        if (this.endpoint) {
            url = `${this.host}/source/${this.endpoint}.${encodeURIComponent(expression)}`;
        }

        return new Observable(observer => {
            // Fetch the URL
            fetch(url).then(async (response) => {
                const reader = response.body?.getReader();
                if (!reader) {
                    observer.error("No body to stream");
                    return;
                }

                try {
                    // Reading the response in chunks
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        observer.next(value); // Emit each chunk (Uint8Array)
                    }
                    observer.complete(); // Complete when done
                } catch (error) {
                    observer.error(error); // Handle errors
                }
            });
        }).pipe(scan((acc, t, idx) => {

            const msg = new TextDecoder().decode(t);


            acc[0].push(msg);

            if (msg.endsWith("\n\n")) {
                return [[], acc[0].join("")]
            } else {
                return [acc[0], null]
            }

        }, [[], null]), filter((t) => {
            if (t[0].length == 0 && t[1].endsWith("\n\n")) {
                return true;
            }
            return false;
        }), map((t) => t[1]), assembler);
    }
}



const client = new Qapi("http://localhost:2020");

client.Source("Source.Tick(1000)").subscribe((t) => {
    console.log(t);
})
