import { createContext, useContext } from "react";
import {scan, filter, map, firstValueFrom, distinctUntilChanged} from "rxjs";


import * as React from "react";
import { useEffect, useState, ComponentType, useCallback } from "react";
import {Observable, Subscription, combineLatest, of, Subject, isObservable} from "rxjs";
import * as Uuid from "uuid";
import string from "zod/src/v3/benchmarks/string";
import { reader } from "next/dist/experimental/testmode/fetch";
import { AssistantModal } from "@/components/assistant-ui/assistant-modal";
import { App, Inner } from "@/app/Runtime";



// The function to handle the object with possible observables or values
export function combineLatestObject<T>(input: { [key: string]: T | Observable<T> }): Observable<{ [key: string]: T }> {
    // Convert all values to observables if they aren't already
    const observables = Object.keys(input).map(key => {
        const value = input[key];
        return isObservable(value) ? value : of(value);
    });

    // Combine the observables and emit the latest values as an object
    return combineLatest(observables).pipe(
        map(values => {
            // Create an object with the latest values
            const result: { [key: string]: T } = {};
            Object.keys(input).forEach((key, index) => {
                result[key] = values[index];
            });
            return result;
        })
    );
}

// This is our global "event bus"
export const eventBus = new Subject<any>();


/**
 * usePublish hook
 * @returns A function that publishes values into the eventBus
 */
export function useDispatch<T = any>(type: string) {
    const publish = useCallback((payload: T) => {
        eventBus.next({type, payload});
    }, []);

    return publish;
}

export function dispatch<T = any>(client: IQapiClient, type: string, endpoint: string) {

    const publish = (payload: T) => {
        client.Dispatch({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
    };

    return publish;
}

export const invokeAsync = <T = any>(client: IQapiClient, type: string, endpoint: string = null) => {


    const publish = (payload: T) => {
        return client.InvokeAsync({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
    };

    return publish;
}

export function invoke(client: IQapiClient, name: string, endpoint: string) {


    const invocation = (...args: any[]) => {
        client.Invoke({Name: name, Args: args, Endpoint: endpoint});
    };

    return invocation;
}


export interface IQapi {
    Source(expression: string): Observable<any>;
}

export class Qapi implements IQapi {
    constructor(private readonly client, private readonly overrides = {}, private readonly variables = {}) {
    }
    Source = (expression: string): Observable<any> => {

        return this.overrides[expression] ?? this.client.Source(expression, this.variables);
    }

    Dispatch = (action)=> {

    }
}

// Types
export type ConfigFunction<T> = (qapi: IQapi) => Observable<T>;


export const Overrides = {};

export function useStream<T>(client: IQapiClient, configFn: ConfigFunction<T>, variables: {[key: string]: any} = {}): T | undefined {

    const [value, setValue] = useState<T>();

    useEffect(() =>  {


        const qapi = new Qapi(client, Overrides, variables);

        let observable = configFn(qapi);

        if (!isObservable(observable)) {
            observable = of(observable);
        }
        const subscription: Subscription = observable.subscribe({
            next: (val) => setValue(val),
            error: (err) => console.error('useStream error:', err),
        });

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    return value;
}



// This is a version of `connect` that returns a HOC
export function connect<TState, TDispatch = any>(
    mapStateToProps: (qapi: IQapiClient, ownProps: {[key: string]: any}, endpoint: string) => Observable<TState>, // mapState function
    mapDispatchToProps: (qapi: IQapi, ownProps, endpoint: string) => any,
    qapiq: (opts) => {

    }// mapDispatch function (actions)
) {



    mapDispatchToProps = mapDispatchToProps ?? ((qapi, ownProps, endpoint) => ({}));

    const qapiqCall = qapiq ?? ((qapiq) => ({}));


    return function <P extends object>(WrappedComponent: ComponentType<P>) {
        // Return a new component wrapped with state and dispatch
        const endpoint = `Interop_${Uuid.v6().replaceAll("-", "")}`;

        return function WithReduxWrapper(props: P) {

            const ctx = useContext(QapiContext);

            const client = ctx.client;
            const stateProps = useStream<TState>(client, (qapi) => mapStateToProps(qapi, props, endpoint), {Endpoint: endpoint});

            const [viewProps, setViewProps] = useState({});

            const disp = mapDispatchToProps({Invoke: (name: string) => invoke(client, name, endpoint), InvokeAsync: (type, graphId) => invokeAsync(client, type, graphId ?? endpoint), Dispatch: (type, graphId) => dispatch(client, type, graphId ?? endpoint), Source: (key: string, ...payload: any) =>
                {
                    if (key.includes(".")) {

                        if (key.startsWith("Context.")) {
                            key = key.replace("Context.", `${endpoint}.`);
                        }

                        return new Qapi(client, {}, {Endpoint: endpoint}).Source(key);
                    } else {
                        return client.Source(`${endpoint}.Stage({Name: '${key}', Payload: ${JSON.stringify(payload)}})`);
                    }
                }}, props, endpoint);

            let assistant = null;

            const qapiq = qapiqCall({
                useAssistant: (v) => {
                    assistant = v;
                }
            });



            const streams = {};

            const dispatchProps = Object.keys(disp).reduce((acc, key) => {

                if (isObservable(disp[key])) {
                    streams[key] = disp[key];
                    return acc;
                } else {
                    acc[key] = (...args: any[]) => disp[key](...args);
                    return acc;
                }

            }, {});


            useEffect(() => {

                const subscription: Subscription = combineLatestObject(streams).subscribe({
                    next: (val) => {
                        setViewProps(val);
                    },
                    error: (err) => console.error('useStream error:', err),
                });

                return () => {
                    subscription.unsubscribe();
                };
            }, []);


            return <><WrappedComponent {...props} {...stateProps} {...dispatchProps} {...viewProps} /></>;

            // Return the wrapped component with state + dispatch injected

        };
    };
}


// --- Types ------------------------------------------------------------------
type ChunkDto = {
    bytes: string;          // base64
    firstChunk: boolean;
    lastChunk: boolean;
    serializerId: number;
    manifest?: unknown | null;
};

// --- Helpers ----------------------------------------------------------------
const b64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
};

// Merge an array of Uint8Array chunks into one Uint8Array
const concatBytes = (parts: Uint8Array[]): Uint8Array => {
    const size = parts.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(size);
    let off = 0;
    for (const a of parts) { out.set(a, off); off += a.length; }
    return out;
};

// --- Operators ---------------------------------------------------------------
// Convert Uint8Array chunks → SSE frames, then emit each JSON in "data:" lines
function sseToChunkDtos() {
    const decoder = new TextDecoder();
    let buf = "";

    return (source: Observable<Uint8Array>) =>
        new Observable<ChunkDto>(observer => {
            const sub = source.subscribe({
                next(value) {
                    // value must be Uint8Array; guard just in case
                    if (!(value instanceof Uint8Array)) {
                        observer.error(new TypeError("Expected Uint8Array from reader"));
                        return;
                    }
                    buf += decoder.decode(value, { stream: true });

                    // SSE frames separated by blank line
                    let idx: number;
                    while ((idx = buf.indexOf("\n\n")) >= 0) {
                        const frame = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);

                        // extract all data: lines (could be multiple per frame)
                        const lines = frame.split("\n");
                        for (const l of lines) {
                            if (!l.startsWith("data:")) continue;
                            const json = l.slice(5).trim();
                            if (!json) continue;
                            try {
                                const payload = JSON.parse(json) as any;
                                // normalize keys in case server uses different casing
                                const dto: ChunkDto = {
                                    bytes: payload.bytes ?? payload.Bytes,
                                    firstChunk: payload.firstChunk ?? payload.FirstChunk ?? false,
                                    lastChunk: payload.lastChunk ?? payload.LastChunk ?? false,
                                    serializerId: payload.serializerId ?? payload.SerializerId ?? 0,
                                    manifest: payload.manifest ?? payload.Manifest ?? null,
                                };
                                observer.next(dto);
                            } catch (e) {
                                observer.error(new Error("Bad JSON in SSE data: " + json));
                            }
                        }
                    }
                },
                error: err => observer.error(err),
                complete() {
                    // flush leftover (rare for SSE)
                    const tail = buf + decoder.decode();
                    if (tail.trim()) {
                        // try one last frame
                        const lines = tail.split("\n");
                        for (const l of lines) {
                            if (!l.startsWith("data:")) continue;
                            const json = l.slice(5).trim();
                            if (!json) continue;
                            try {
                                const payload = JSON.parse(json);
                                observer.next(payload as ChunkDto);
                            } catch { /* ignore */ }
                        }
                    }
                    observer.complete();
                }
            });
            return () => sub.unsubscribe();
        });
}

// Assemble multi-part DTOs into bytes and emit UTF-8 strings (or bytes)
function assembleDtoStream({ emitBytes = false }: { emitBytes?: boolean } = {}) {
    // Track parts per serializerId
    const parts = new Map<number, Uint8Array[]>();
    const decoder = new TextDecoder();

    return (source: Observable<ChunkDto>) =>
        new Observable<string | Uint8Array>(observer => {
            const sub = source.subscribe({
                next(dto) {
                    const chunk = b64ToBytes(dto.bytes || "");
                    // collect
                    const list = parts.get(dto.serializerId) ?? [];
                    list.push(chunk);
                    parts.set(dto.serializerId, list);

                    // if this event says it's a single-part or the last part, flush it
                    if ((dto.firstChunk && dto.lastChunk) || dto.lastChunk) {
                        const merged = concatBytes(parts.get(dto.serializerId)!);
                        parts.delete(dto.serializerId);

                        if (emitBytes) {
                            observer.next(merged);
                        } else {
                            observer.next(decoder.decode(merged));
                        }
                    }
                },
                error: err => observer.error(err),
                complete: () => observer.complete(),
            });
            return () => sub.unsubscribe();
        });
}

// --- Original assembleChunks (kept but corrected to accept BYTES) -----------
function assembleChunks(collectedChunks: Uint8Array[]) {
    const merged = concatBytes(collectedChunks);
    const decodedString = new TextDecoder("utf-8").decode(merged);
    return JSON.parse(decodedString);
}

// --- QapiClient --------------------------------------------------------------

export interface IQapiClient {
    InitializeAsync(): Promise<any>;
    Source(expression: string, variables: {[key: string]: any}): Observable<any>;
    Query(expression: string, variables: {[key: string]: any}): Promise<any>;
    Dispatch(action: {Type: string, Payload: any, Meta: {[key: string]: any}}): Promise<void>;
    InvokeAsync(action: {Type: string, Payload: any, Meta: {[key: string]: any}}): Promise<any>;
}

export class QapiClient implements IQapiClient {

    private _events: Subject<{Id: string, Data: any}> = new Subject();
    private _subscription: Subscription | null = null;

    constructor(private readonly host: string, private readonly sessionId = Uuid.v4().toString()) {
        this.InitializeAsync().then((t) => {
            console.log("CONNECTED")
        });
    }


    public async Dispatch(action: {Type: string, Payload: any, Meta: {[key: string]: any}}) {
        let url = `${this.host}/dispatch`;

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" }, // triggers preflight
            body: JSON.stringify({...action, Meta: {...action.Meta}})

        });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
        }

        return await res.json();
    }

    public async Query(expression: string, variables: {[key: string]: any} = {}): Promise<any> {
        this.Subscribe();

        this.Dispatch({Type: "Subscribe", Payload: {Expression: expression, Id: expression, IsStream: false, Variables: {...variables}}, Meta: {
                Endpoint: this.sessionId
            }}).then((t) => {

        });

        return firstValueFrom<any>(this._events.pipe(filter((t) => t.Id == expression), map((t) => t.Data as any)));
    }

    private async QueryInternal(expression: string): Promise<any> {
        let url = `${this.host}/query/${encodeURIComponent(expression)}`;


        const res = await fetch(url, {

        });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
        }
        return await res.json();
    }

    private Subscribe()  {
        if (!this._subscription) {

            this._subscription = this.SourceInternal(`${this.sessionId}.SubscribeToEvents()`).subscribe((t) => {
                console.log(t);
                this._events.next(JSON.parse(t));
            });

        }
    }

    public Source(expression: string, variables: {[key: string]: any} = {}) {

        this.Subscribe();

        this.Dispatch({Type: "Subscribe", Payload: {Expression: expression, Id: expression, IsStream: true, Variables: {...variables}}, Meta: {
                Endpoint: this.sessionId
            }}).then((t) => {

        });

        return this._events.pipe(filter((t) => t.Id == expression), map((t) => t.Data), distinctUntilChanged())
    }

    private SourceInternal(expression: string) : Observable<any> {

        let url = `${this.host}/source/${encodeURIComponent(expression)}`;

        // Stream the raw bytes from fetch into an Observable<Uint8Array>
        const byteStream$ = new Observable<Uint8Array>(observer => {
            fetch(url, {
                headers: {"Content-Type": "text/event-stream", "Accept": "text/event-stream"},
            })
                .then(async res => {
                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");
                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }
                    const ct = res.headers.get("content-type") || "";
                    if (!ct.includes("text/event-stream")) {
                        console.warn("Unexpected Content-Type:", ct);
                    }
                    const reader = res.body?.getReader();
                    if (!reader) {
                        observer.error("No body to stream");
                        return;
                    }
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            if (value) observer.next(value);        // Uint8Array
                        }
                        observer.complete();
                    } catch (e) {
                        observer.error(e);
                    }
                })
                .catch(e => observer.error(e));
        });

        // Pipeline: bytes → SSE DTOs → assembled UTF-8 strings (or bytes)
        return byteStream$.pipe(
            sseToChunkDtos(),
            assembleDtoStream({ emitBytes: false }) // set true if you want Uint8Array
        );
    }

    public InitializeAsync(): Promise<any> {

        this.SourceInternal(`SessionManager.Initialize({SessionId: '${this.sessionId}'})`).pipe(distinctUntilChanged()).subscribe((t) => {
            console.log(t+6666+3)
        });

        return Promise.resolve(undefined);
    }

    async InvokeAsync(action: { Type: string; Payload: any; Meta: { [p: string]: any } }): Promise<any> {
        let url = `${this.host}/invoke`;

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" }, // triggers preflight
            body: JSON.stringify({...action, Meta: {...action.Meta}})

        });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
        }

        return await res.json();
    }
}




export const QapiContext = createContext<{
    client: IQapiClient
}>({

});



