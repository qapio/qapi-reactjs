import { createContext } from "react";
import {scan, filter, map} from "rxjs";


import * as React from "react";
import { useEffect, useState, ComponentType, useCallback } from "react";
import {Observable, Subscription, combineLatest, of, Subject, isObservable, finalize} from "rxjs";
import * as Uuid from "uuid";




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

export function dispatch<T = any>(type: string, endpoint: string = null) {

  const client = window.client ?? new QapiClient("https://politiloggen.qapio.com");

  const publish = (payload: T) => {
    client.Dispatcher({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
  };

  return publish;
}

export const invokeAsync = <T = any>(type: string, endpoint: string = null) => {

  const client = window.client ?? new QapiClient("https://politiloggen.qapio.com");

  const publish = (payload: T) => {
    return client.InvokeAsync({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
  };

  return publish;
}

export function invoke(name: string, endpoint: string) {

  const client = window.client ?? new QapiClient("https://politiloggen.qapio.com");

  const invocation = (...args: any[]) => {
    lient.Invoke({Name: name, Args: args, Endpoint: endpoint});
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

export function useStream<T>(configFn: ConfigFunction<T>, variables: {[key: string]: any} = {}): T | undefined {
  const [value, setValue] = useState<T>();

  const client = window.client ?? new QapiClient("https://politiloggen.qapio.com")
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
  mapStateToProps: (state: IQapi, ownProps: {[key: string]: any}, endpoint: string) => Observable<TState>, // mapState function
  mapDispatchToProps: (qapi, ownProps, endpoint: string) => any // mapDispatch function (actions)
) {

  const client = document.client ?? new QapiClient("https://politiloggen.qapio.com");


  mapDispatchToProps = mapDispatchToProps ?? ((qapi, ownProps, endpoint) => ({}));


  return function <P extends object>(WrappedComponent: ComponentType<P>) {
    // Return a new component wrapped with state and dispatch
    const endpoint = `Interop_${Uuid.v6().replaceAll("-", "")}`;

    return function WithReduxWrapper(props: P) {

      const stateProps = useStream<TState>((qapi) => mapStateToProps(qapi, props, endpoint), {Endpoint: endpoint});

      const [viewProps, setViewProps] = useState({});

      const disp = mapDispatchToProps({Invoke: (name: string) => invoke(name, endpoint), InvokeAsync: (type, graphId) => invokeAsync(type, graphId ?? endpoint), Dispatch: (type, graphId) => dispatch(type, graphId ?? endpoint), Source: (key: string, ...payload: any) =>
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

      // Return the wrapped component with state + dispatch injected
      return <WrappedComponent {...props} {...stateProps} {...dispatchProps} {...viewProps} />;
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
  Source(expression: string): Observable<any>;
}

export class QapiClient implements IQapiClient {
  constructor(private readonly host: string) {}

  public async Query(expression: string): Promise<any> {
    let url = `${this.host}/query/${encodeURIComponent(expression)}`;


    const res = await fetch(url, {

    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }
    return await res.json();
  }

  public Source(expression: string) {
    let url = `${this.host}/source/${encodeURIComponent(expression)}`;

    // Stream the raw bytes from fetch into an Observable<Uint8Array>
    const byteStream$ = new Observable<Uint8Array>(observer => {
      fetch(url, {
        headers: {"Content-Type": "text/event-stream", "Accept": "text/event-stream", "Cache-Control": "no-transform" },
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
              console.log("DSØHSØ")
              const { done, value } = await reader.read();
              console.log(done)
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
}




export const QapiContext = createContext<{
  host?: string
}>({

});



