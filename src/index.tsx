import * as React from "react";
import { useEffect, useState, ComponentType, useCallback } from "react";
import {Observable, Subscription, map, combineLatest, of, Subject, isObservable, finalize} from "rxjs";
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

    const publish = (payload: T) => {
        window.client.Dispatcher({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
    };

    return publish;
}

export const invokeAsync = <T = any>(type: string, endpoint: string = null) => {

    const publish = (payload: T) => {
       return window.client.InvokeAsync({Type: type, Payload: payload, Meta: {Endpoint: endpoint}});
    };

    return publish;
}

export function invoke(name: string, endpoint: string) {

    const invocation = (...args: any[]) => {
        window.client.Invoke({Name: name, Args: args, Endpoint: endpoint});
    };

    return invocation;
}


export interface IQapi {

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

    useEffect(() =>  {
        const qapi = new Qapi(window.client, Overrides, variables);

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
    mapDispatchToProps = mapDispatchToProps ?? ((qapi, ownProps, endpoint) => ({}));
   // const safeMapDispatch = mapDispatchToProps ?? ((/*qapi, ownProps, endpoint*/) => ({} as TDispatch));

    return function <P extends object>(WrappedComponent: ComponentType<P>) {
        // Return a new component wrapped with state and dispatch
/*        const endpointRef = React.useRef<string>();
        if (!endpointRef.current) {
            // use your Uuid.v6 if needed; I’ll use v4 here as a stand-in
            endpointRef.current = `Interop_${Uuid.v6().replaceAll("-", "")}`;
        }
        const endpoint = endpointRef.current;*/
        //const endpoint = `Interop_${Uuid.v6().replaceAll("-", "")}`;

        function WithReduxWrapper(props: P) {

            const endpointRef = React.useRef<string>();
            if (!endpointRef.current) {
                endpointRef.current = `Interop_${Uuid.v6().replaceAll("-", "")}`;
            }
            const endpoint = endpointRef.current!;


            const qapiFacade = React.useMemo(() => ({
                Invoke: (name: string) => invoke(name, endpoint),
                InvokeAsync: (type: any, graphId?: string) => invokeAsync(type, graphId ?? endpoint),
                Dispatch: (type: any, graphId?: string) => dispatch(type, graphId ?? endpoint),
                Source: (key: string, ...payload: any[]) => {
                    if (key.includes(".")) {
                        if (key.startsWith("Context.")) key = key.replace("Context.", `${endpoint}.`);
                        return new Qapi(window.client, {}, { Endpoint: endpoint }).Source(key);
                    }
                    return window.client.Source(
                        `${endpoint}.Stage({Name: '${key}', Payload: ${JSON.stringify(payload)}})`
                    );
                }
            }), [endpoint]);

            const stateProps = useStream<TState>((qapi) => mapStateToProps(qapi, props, endpoint), {Endpoint: endpoint});

            const disp = React.useMemo(
                () => mapDispatchToProps(qapiFacade as any, props as any, endpoint),
                [qapiFacade, props, endpoint]
            );

            const { dispatchProps, streams } = React.useMemo(() => {
                const s: Record<string, Observable<any>> = {};
                const d: Record<string, any> = {};

                Object.keys(disp as any).forEach((key) => {
                    const val = (disp as any)[key];
                    if (isObservable(val)) {
                        s[key] = val;
                    } else if (typeof val === "function") {
                        // preserve function identity but bind to latest val via closure
                        d[key] = (...args: any[]) => val(...args);
                    } else {
                        d[key] = val; // constants are fine
                    }
                });

                return { dispatchProps: d as TDispatch, streams: s };
            }, [disp]);


            const [viewProps, setViewProps] = useState<Record<string, any>>({});

            useEffect(() => {
                const keys = Object.keys(streams);
                if (keys.length === 0) {
                    setViewProps({});
                    return; // nothing to subscribe to
                }

                const subscription: Subscription = combineLatestObject(streams).subscribe({
                    next: (val) => setViewProps(val),
                    error: (err) => console.error("useStream error:", err),
                });

                return () => subscription.unsubscribe();
            }, [streams]); // re-run if streams map changes

            // 7) Render with merged props
            return (
                <WrappedComponent
                    {...props}
                    {...(stateProps as any)}
                    {...(dispatchProps as any)}
                    {...viewProps}
                />
            );
        }

        (WithReduxWrapper as any).displayName =
            `connect(${WrappedComponent.displayName || WrappedComponent.name || "Component"})`;

        return WithReduxWrapper;
    };
}
