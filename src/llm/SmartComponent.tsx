import {createContext, useContext, useEffect, useState} from "react";
import {Connect} from "../Index";
import {filter, map, Observable, Subject} from "rxjs";
import * as uuid from "uuid";
import {convertJsonSchemaToZod} from "zod-from-json-schema";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}



function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="skeleton"
            className={cn("animate-pulse rounded-md bg-black/10", className)}
            {...props}
        />
    );
}


type ProfileType = {
    nickname: string
}
type AssistantType = {
    profile: ProfileType;
    audience: string[]
};

const generateContextData = (assistant: AssistantType, onNext) => {

    const [schemas, setSchemas] = useState({});
    const [tasks, setTasks] = useState([]);
    const [response, _] = useState(new Subject());

    useEffect(() => {
        if (Object.keys(schemas).length == 0) {
            return;
        }

        onNext({schemas, tasks}).then((t) => {
            t.items.forEach((t) => {
                response.next(t);
            });
        });

    }, [schemas, tasks]);

    return ({
        ...assistant,
        getPropsAsync: ({prompt, schema}) => {
            const id = prompt+schema.type;

            setSchemas((a) => ({...a, [schema.type]: JSON.stringify(schema.schema)}))
            setTasks((t) => ([...t, {id, schemaType: schema.type, prompt}]));


            return response.pipe(filter((t) => t.id == id), map((t) => t.props));
        }
    });
};

type AssistantContext = AssistantType & {
    getPropsAsync: <TProps>({prompt, assistant, schema, responseStream}) => Observable<TProps>;
}

export const QapiqApp = Connect((qapiq, {endpoint, options}) => qapiq.Source(`${endpoint}.Assistant.Connect({})`), (qapiq, {endpoint, options}) => ({
    onNext: ({schemas, tasks}) => {
        return qapiq.InvokeAsync("GenerateContent", `${endpoint}_Assistant`)({Schemas: schemas, Fragments: tasks, Options: options ?? {}});
    }
}))(({children, onNext, options}) => {


    return     <QapiqContext value={generateContextData({

    }, onNext)}>{children}</QapiqContext>
});

const QapiqContext = createContext<AssistantContext>({});
export const makeSmart = (type: string , schema: string, emptyContent: React.FC = null) => (component) => {

    return (p) => {

        const ctx = useContext(QapiqContext);

        const [derivedProps, setDerivedProps] = useState<{text: string}>(null);

        const Component = component;

        useEffect(() => {

            if (!p.prompt) {
                setDerivedProps(p);
                return;
            }

            const sub = ctx
                .getPropsAsync({prompt: p.prompt, schema: {type, schema}})
                .subscribe((t) => {

                    console.log(schema);

                    const jsonSchema = schema;
                    const zodSchema = convertJsonSchemaToZod(jsonSchema);

                    console.log(zodSchema);
                    try {
                        const parsed = zodSchema.parse(t);
                        console.log("Valid!", parsed);
                    } catch (err) {
                        console.log("FAIL!")
                        // console.error(err);
                        //return;
                    }
                    console.log("JEHE", t)
                    setDerivedProps(t);

                    return () => {
                        sub.unsubscribe();
                    }
                });


        }, [p]);

        if (!derivedProps) {
            return emptyContent ? emptyContent({skeleton: (className: "text" | "avatar" | "button" | "card" | string) => {

                    const map = {
                        text: "h-4 w-[250px]",
                        avatar: "h-12 w-12 rounded-full",
                        card: "h-[125px] w-[250px] rounded-xl",
                        button: "h-9 w-28 rounded-md"
                    };


                    return <Skeleton className={map[className] || className}/>;
                }}) : "SKELETON";
        }

        return <Component  {...derivedProps}/>
    };
}