import * as React from "react";
import { useEffect, useState, ComponentType, useCallback } from "react";
import {Observable, Subscription, map, combineLatest, of, Subject, isObservable, NEVER} from "rxjs";
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

    useEffect(() => {
        let observable = configFn(new Qapi(window.client, Overrides, variables));

        if (!isObservable(observable)) {
            observable = of(observable);
        }
        const subscription: Subscription = observable.subscribe({
            next: (val) => setValue(val),
            error: (err) => console.error('useStream error:', err),
        });

        return () => subscription.unsubscribe();
    }, []);

    return value;
}



// This is a version of `connect` that returns a HOC
export function connect<TState, TDispatch = any>(
    mapStateToProps: (state: IQapi, ownProps: {[key: string]: any}) => Observable<TState>, // mapState function
    mapDispatchToProps: (qapi, ownProps) => any // mapDispatch function (actions)
) {
    mapDispatchToProps = mapDispatchToProps ?? ((qapi, ownProps) => ({}));


    return function <P extends object>(WrappedComponent: ComponentType<P>) {
        // Return a new component wrapped with state and dispatch
        const endpoint = `Interop_${Uuid.v6().replaceAll("-", "")}`;

        return function WithReduxWrapper(props: P) {

            const stateProps = useStream<TState>((qapi) => mapStateToProps(qapi, props), {Endpoint: endpoint});

            const [viewProps, setViewProps] = useState({});

            const disp = mapDispatchToProps({Dispatch: (type, graphId) => dispatch(type, graphId ?? endpoint), Source: (key: string, ...payload: any) =>
            {
                if (key.includes(".")) {
                    return new Qapi(window.client, {}, {Endpoint: endpoint}).Source(key);
                } else {
                    return window.client.Source(`${endpoint}.Stage({Name: '${key}', Payload: ${JSON.stringify(payload)}})`);
                }
            }}, props);

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
            }, [stateProps]);

            // Return the wrapped component with state + dispatch injected
            return <WrappedComponent {...props} {...stateProps} {...dispatchProps} {...viewProps} />;
        };
    };
}
