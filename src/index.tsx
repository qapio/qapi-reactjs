import * as React from "react";
import { useEffect, useState, ComponentType, useCallback } from "react";
import {Observable, Subscription, map, combineLatest, of, Subject, isObservable} from "rxjs";


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
        console.log("JAJA!")
        eventBus.next({type, payload});
    }, []);

    return publish;
}

export function dispatch<T = any>(type: string) {

    const publish = (payload: T) => {
        console.log("HAL"+payload)
        eventBus.next({type, payload});
    };

    return publish;
}


// Types
export type ConfigFunction<T> = (qapi: IQapi) => Observable<T>;


export function useStream<T>(configFn: ConfigFunction<T>): T | undefined {
    const [value, setValue] = useState<T>();

    useEffect(() => {
        let observable = configFn(window.client);

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

export interface IQapi {

}

export class Qapi implements IQapi {
    Source(expression: string): Observable<any> {
        return window.client.Source(expression);
    }
}

// This is a version of `connect` that returns a HOC
export function connect<TState, TDispatch = any>(
    mapStateToProps: (state: IQapi, ownProps: {[key: string]: any}) => Observable<TState>, // mapState function
    mapDispatchToProps: any // mapDispatch function (actions)
) {
    mapDispatchToProps = mapDispatchToProps ?? {};
    return function <P extends object>(WrappedComponent: ComponentType<P>) {
        // Return a new component wrapped with state and dispatch
        return function WithReduxWrapper(props: P) {

            const stateProps = useStream<TState>((qapi) => mapStateToProps(qapi, props));
            //const dispatch = useDispatch();

            // Map dispatch actions to props
            const dispatchProps = Object.keys(mapDispatchToProps).reduce((acc, key) => {
                acc[key] = (...args: any[]) => mapDispatchToProps[key](...args);
                return acc;
            }, {});

            // Return the wrapped component with state + dispatch injected
            return <WrappedComponent {...props} {...stateProps} {...dispatchProps} />;
        };
    };
}
