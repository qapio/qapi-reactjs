import {
  combineLatest,
  distinctUntilChanged, filter, firstValueFrom, isObservable, map, Observable, of, ReplaySubject, Subject, Subscription
} from "rxjs";
import { ComponentType, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as Uuid from "uuid";
import * as React from "react";

export interface IQapiClient {
    InitializeAsync(): Promise<any>;
    Source(expression: string, variables: {[key: string]: any}): Observable<any>;
    Query(expression: string, variables: {[key: string]: any}): Promise<any>;
    Dispatch(action: {Type: string, Payload: any, Meta: {[key: string]: any}}): Promise<void>;
    InvokeAsync(action: {Type: string, Payload: any, Meta: {[key: string]: any}}): Promise<any>;
}

type Qapi = {
  Source<T>(expression: string): Observable<T>;
};

type Dispatcher = {
  Dispatch<T>(type: string): (payload: T) => void;
  InvokeAsync<T, TResult>(type: string): (payload: T) => Promise<TResult>;
}

export interface IQapiClient {
  InitializeAsync(): Promise<any>;

  Source(expression: string, variables: { [key: string]: any }): Observable<any>;

  Query(expression: string, variables: { [key: string]: any }): Promise<any>;

  Dispatch(action: { Type: string, Payload: any, Meta: { [key: string]: any } }): Promise<void>;

  InvokeAsync(action: { Type: string, Payload: any, Meta: { [key: string]: any } }): Promise<any>;
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
  for (const a of parts) {
    out.set(a, off);
    off += a.length;
  }
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
                  manifest: payload.manifest ?? payload.Manifest ?? null
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
              } catch { /* ignore */
              }
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
        complete: () => observer.complete()
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

export class QapiClient implements IQapiClient {

  private _events: Subject<{ Id: string, Data: any }> = new Subject();
  private _subscriptions: Subscription[] = [];
  private _dispatch: ReplaySubject<any> = new ReplaySubject<any>(128);
  private _isSubscribed: boolean = false;

  constructor(private readonly host: string, private readonly sessionId: string = `Interop_${Uuid.v6().replaceAll("-", "")}`) {

    this.InitializeAsync().then((t) => {
      this._subscriptions.push(this._dispatch.subscribe((t) => {
        this.Dispatch(t);
      }));
    });
  }

  public Dispose() {
    this._subscriptions.forEach((t) => {
      t.unsubscribe();
    });
  }

  public Dispatch = async (action: { Type: string, Payload: any, Meta: { [key: string]: any } }) => {
    let url = `${this.host}/dispatch`;
    console.log(url);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // triggers preflight
      body: JSON.stringify({ ...action, Meta: { ...action.Meta } })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }
    return await res.json().then((t) => {

    });
  };

  public async Query(expression: string, variables: { [key: string]: any } = {}): Promise<any> {
    this.Subscribe();

    this.Dispatch({
      Type: "Subscribe",
      Payload: { Expression: expression, Id: expression, IsStream: false, Variables: { ...variables } },
      Meta: {
        Endpoint: this.sessionId
      }
    }).then((t) => {

    });

    return firstValueFrom<any>(this._events.pipe(filter((t) => t.Id == expression), map((t) => t.Data as any)));
  }

  private async QueryInternal(expression: string): Promise<any> {
    let url = `${this.host}/query/${encodeURIComponent(expression)}`;


    const res = await fetch(url, {});

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }
    return await res.json();
  }

  private Subscribe = () => {
    if (!this._isSubscribed) {

      this._subscriptions.push(this.SourceInternal(`${this.sessionId}.SubscribeToEvents()`).subscribe((t) => {
        this._events.next(JSON.parse(t));
      }));

      this._isSubscribed = true;
    }
  };

  public Source = (expression: string, variables: { [key: string]: any } = {}) => {

    this.Subscribe();

    this._dispatch.next({
      Type: "Subscribe",
      Payload: { Expression: expression, Id: expression, IsStream: true, Variables: { ...variables } },
      Meta: {
        Endpoint: this.sessionId
      }
    });

    return this._events.pipe(filter((t) => {
      return t.id == expression;
    }), map((t) => t.data), distinctUntilChanged());
  };

  private SourceInternal(expression: string): Observable<any> {

    let url = `${this.host}/source/${encodeURIComponent(expression)}`;

    // Stream the raw bytes from fetch into an Observable<Uint8Array>
    const byteStream$ = new Observable<Uint8Array>(observer => {
      fetch(url, {
        headers: { "Content-Type": "text/event-stream", "Accept": "text/event-stream" }
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
      console.log(t + 6666 + 3);
    });

    return Promise.resolve(undefined);
  }

  InvokeAsync = async (action: { Type: string; Payload: any; Meta: { [p: string]: any } }): Promise<any> => {
    let url = `${this.host}/invoke`;

    console.log(action);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // triggers preflight
      body: JSON.stringify({ ...action, Meta: { ...action.Meta } })

    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }

    console.log("AHØG!")
    return await res.json();
  }
}


export const QapiContext = createContext<{
  client: IQapiClient
}>({});


export function useQapiSource<T = any>(stream: () => Observable<T>): T | undefined {

  const [data, setData] = useState<T>();

  useEffect(() => {

    const str = stream();

    if (!isObservable(str)) {
      setData(str);
      return;
    }

    const subscription: Subscription = str.subscribe({
      next: (t) => setData(t),
      error: (err) => console.log("useStream error:", err)
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return data;
}


function combineLatestObject(input: { [key: string]: Observable<any> }): Observable<{ [key: string]: any }> {
  // Convert all values to observables if they aren't already
  const observables = Object.keys(input).map(key => {
    const value = input[key];
    return isObservable(value) ? value : of(value);
  });

  // Combine the observables and emit the latest values as an object
  return combineLatest(observables).pipe(
    map(values => {
      // Create an object with the latest values
      const result: { [key: string]: any } = {};
      Object.keys(input).forEach((key, index) => {
        result[key] = values[index];
      });
      return result;
    })
  );
}

type Qapiq = {
  assistant: "Qapiq"
}

const useAssistant = (endpoint: string) => (component) => {

  const Component = component;

  return (props) => <div>
    <Component {...props}/>
    <div className={"relative"}>
      {endpoint}
    </div>
  </div>;
}




export function Connect<TStateData extends object = any, TProps extends object = any, TOwnProps extends object = any>(
  stateData?: (qapi: Qapi, ownProps: TOwnProps) => Observable<TStateData>,
  props?: (qapi: Qapi & Dispatcher, ownProps: TOwnProps) => TProps,
  qapiq?: Qapiq
) {
  const stateDataFn = stateData ?? ((qapi) => ({} as TStateData));
  const propsFn = props ?? ((qapi) => ({}));
  const qapiqFn = qapiq ?? {};

  return function (Component: ComponentType<TOwnProps>) {


    function WithQapi(ownProps: TOwnProps) {

      const ctx = useContext(QapiContext);

      const endpointRef = useRef<string | undefined>(undefined);

      if (!endpointRef.current) {
        endpointRef.current = `Interop_${Uuid.v6().replaceAll("-", "")}`;
      }

      const endpoint = endpointRef.current!;

      const qapi = useMemo<Qapi & Dispatcher>(() => {
        return ({
          Source<T>(expression: string): Observable<T> {
            if (expression.startsWith("Context.")) {
              return ctx.client.Source(expression.replace("Context.", `${endpoint}.`), { Endpoint: endpoint });
            }
            return ctx.client.Source(expression, { Endpoint: endpoint });
          },
          Dispatch<T>(type: string): (payload: T) => void {
            return (payload) => ctx.client.Dispatch({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
          },
          InvokeAsync<T, TResult>(type: string): (payload: T) => Promise<TResult> {
            console.log(type)
            return (payload) => ctx.client.InvokeAsync({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
          }
        });
      }, [endpoint]);

      const stateStream = useQapiSource<TStateData>(() => stateDataFn(qapi, ownProps));

      const otherProps = useMemo<TProps>(() => propsFn(qapi, ownProps), [qapi, ownProps, endpoint]);

      const { others, streams } = useMemo<TProps>(() => {

        const streams: Record<string, Observable<any>> = {};
        const others: Record<string, any> = {};

        Object.keys(otherProps).forEach((key) => {
          const val = (otherProps)[key];
          if (isObservable(val)) {
            streams[key] = val;
          } else {
            others[key] = val; // constants are fine
          }
        });

        return { streams, others };

      }, [otherProps]);

      const [snapshot, setSnapshot] = useState<Record<string, any>>({});

      useEffect(() => {

        const keys = Object.keys(streams);

        if (keys.length === 0) {
          setSnapshot({});
          return;
        }

        const subscription: Subscription = combineLatestObject(streams).subscribe({
          next: (val) => setSnapshot(val),
          error: (err) => console.error("useStream error:", err)
        });

        return () => subscription.unsubscribe();

      }, [streams]);

      return <Component
        {...stateStream}
        {...ownProps}
        {...others}
        {...snapshot}
      />;
    }

    WithQapi.displayName = `connect(${WithQapi.displayName || WithQapi.name || "Component"})`;

    if (qapiqFn.assistant) {
     return useAssistant("Qapiq")(WithQapi);
    }

    return WithQapi;
  };
}

