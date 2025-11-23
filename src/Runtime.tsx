
// Create a context for thread management
import { createContext, ReactNode, useContext, useState } from "react";
import {
    AppendMessage,
    AssistantRuntimeProvider, ExportedMessageRepository, ExternalStoreThreadData,
    ExternalStoreThreadListAdapter,
    MessageStatus,
    ThreadMessageLike as ThreadBase,
    useExternalStoreRuntime
} from "@assistant-ui/react";
import * as React from "react";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { Thread } from "@/components/assistant-ui/thread";
import { generateId } from "ai";
import { connect, QapiClient, QapiContext } from "./QapiContext";
import { map } from "rxjs";
import { Button } from "@/components/ui/button";
import { AssistantModal } from "@/components/assistant-ui/assistant-modal";

type MessageCommonProps = {
    readonly id: string;
    readonly createdAt: Date;
};

type ThreadMessageLike = ThreadBase & MessageCommonProps & {id: string, parentId: string | null, status: MessageStatus | undefined, metadata: any | undefined};

type Thread = {Messages: ThreadMessageLike[], HeadId: string | null}


const ThreadContext = createContext<{
    onReload: (m) => Promise<ThreadMessageLike>;
    onNext: (msg: ThreadMessageLike) => Promise<ThreadMessageLike>;
    onCreateThread,
    onArchiveThread,
    onSwitchThread,
    currentThreadId: string;
    setCurrentThreadId: (id: string) => void;
    threads: Map<string, Thread>;
    setThreads: React.Dispatch<
        React.SetStateAction<Map<string, Thread>>
    >;
}>({
    onReload: (m: ThreadMessageLike) => Promise.resolve(1 as any),
    onNext: (m: ThreadMessageLike) => Promise.resolve(1 as any),
    onCreateThread: null,
    onSwitchThread: null,
    onArchiveThread: null,
    currentThreadId: "default",
    setCurrentThreadId: () => {},
    threads: new Map(),
    setThreads: () => {},
});

// Thread provider component
export function ThreadProvider({ children, threads: initialThreads, onArchiveThread, currentThreadId: initialCurrentThreadId, onCreateThread, onNext, onReload, onSwitchThread }: { children: ReactNode, threads: {[key: string]: Thread}, currentThreadId: string, onNext: (message: ThreadMessageLike) => Promise<ThreadMessageLike>, onReload, onCreateThread, onSwitchThread, onArchiveThread }) {
    const [threads, setThreads] = useState<Map<string, Thread>>(new Map<string, Thread>(Object.entries(initialThreads)));
    const [currentThreadId, setCurrentThreadId] = useState(initialCurrentThreadId);

    return (
        <ThreadContext.Provider
            value={{ currentThreadId, setCurrentThreadId, threads, setThreads, onArchiveThread, onNext, onReload, onCreateThread, onSwitchThread }}
        >
            {children}
        </ThreadContext.Provider>
    );
}

// Hook for accessing thread context
export function useThreadContext() {
    const context = useContext(ThreadContext);
    if (!context) {
        throw new Error("useThreadContext must be used within ThreadProvider");
    }
    return context;
}

export function ChatWithThreads({isModal=false}) {
    const { currentThreadId, setCurrentThreadId, threads, setThreads, onNext, onArchiveThread, onReload, onCreateThread, onSwitchThread } =
        useThreadContext();

    const [threadList, setThreadList] = useState<ExternalStoreThreadData<any>[]>(Array.from(threads.entries()).map((t) => ({id: t[0], status: t[1].Status, title: t[0]})));

    const [isRunning, setIsRunning] = useState(false);


    const threadListAdapter: ExternalStoreThreadListAdapter = {
        threadId: currentThreadId,
        threads: threadList.filter((t) => t.status === "regular"),
        archivedThreads: threadList.filter((t) => t.status === "archived"),

        onSwitchToNewThread: async () => {

            const newId = `thread-${Date.now()}`;
            setThreadList((prev) => [
                ...prev,
                {
                    id: newId,
                    status: "regular",
                    title: "New Chat",
                },
            ]);
            setIsRunning(true);
            await onCreateThread({id: newId})
            console.log("CPM")
            setThreads((prev) => new Map(prev).set(newId, {Messages: [], HeadId: null}));
            setCurrentThreadId(newId);
            setIsRunning(false)
        },

        onSwitchToThread: async (threadId) => {
            setIsRunning(true)
            await onSwitchThread({id: threadId})
            setCurrentThreadId(threadId);
            setIsRunning(false);
        },

        onRename: (threadId, newTitle) => {
            setThreadList((prev) =>
                prev.map((t) =>
                    t.id === threadId ? { ...t, title: newTitle } : t,
                ),
            );
        },

        onArchive: async (threadId) => {

            setIsRunning(true)

            await onArchiveThread({id: threadId})

            setThreadList((prev) =>
                prev.map((t) =>
                    t.id === threadId ? { ...t, status: "archived" } : t,
                ),
            );

            setIsRunning(false)
        },

        onDelete: (threadId) => {
            console.log("AA")
            setThreadList((prev) => prev.filter((t) => t.id !== threadId));
            setThreads((prev) => {
                const next = new Map(prev);
                next.delete(threadId);
                return next;
            });
            if (currentThreadId === threadId) {
                setCurrentThreadId("default");
            }
        },
    };

    const runtime = useExternalStoreRuntime({
        isRunning,
        setMessages: (messages: readonly ThreadMessageLike[]) => {

            console.log(messages);

            setThreads((prev) => {
                const thread = prev.get(currentThreadId) ?? { Messages: [], HeadId: null };

                return new Map(prev).set(currentThreadId, {
                    Messages: thread.Messages,
                    HeadId: messages[messages.length - 1].id
                });
            });
        },
        onNew: async (message: AppendMessage) => {
            const id1 = generateId();

            const msg = {...message, id: id1}

            setThreads((prev) => {


                const thread = prev.get(currentThreadId) ?? { Messages: [], HeadId: null };

                const next = [...thread.Messages, msg as ThreadMessageLike];

                return new Map(prev).set(currentThreadId, {
                    Messages: next, HeadId: id1
                });
            });

            setIsRunning(true);
            await new Promise(r => setTimeout(r, 200000));
            const reply = await onNext({...msg, MessageId: id1});


            var messages = reply.messages.map((t) => ({...t, id: t.messageId, metadata: {}, attachments: [], ...t.additionalProperties, parentId: t.additionalProperties?.ParentId, content: t.contents.map((t) => {
                    if (t.$type == "text") {
                        return {type: "text", text: t.text};
                    }
                    return {};
                })}));


            setIsRunning(false);

            setThreads((prev) => {

                const thread = prev.get(currentThreadId) ?? { Messages: [], HeadId: null };

                console.log("WANNABEHEAD", messages[messages.length-1].id)
                const next = [...thread.Messages,
                    ...messages];
                return new Map(prev).set(currentThreadId, {
                    Messages: next, HeadId: messages[messages.length-1].id
                });
            });
            setIsRunning(false);
        },
        onEdit: async (m) => {
            const id = generateId();
            setThreads((prev) => {


                const thread = prev.get(currentThreadId);

                const next = [...thread.Messages, {...m, id} as ThreadMessageLike];

                return new Map(prev).set(currentThreadId, {
                    Messages: next, HeadId: id
                });
            });

            setIsRunning(true);

            const reply = await onNext({...m, MessageId: id});


            var messages = reply.messages.map((t) => ({...t, id: t.messageId, metadata: {}, attachments: [], ...t.additionalProperties, parentId: t.additionalProperties?.ParentId, content: t.contents.map((t) => {
                    if (t.$type == "text") {
                        return {type: "text", text: t.text};
                    }
                    return {};
                })}));


            setIsRunning(false);

            setThreads((prev) => {

                const thread = prev.get(currentThreadId) ?? { Messages: [], HeadId: null };

                console.log("WANNABEHEAD", messages[messages.length-1].id)
                const next = [...thread.Messages,
                    ...messages];
                return new Map(prev).set(currentThreadId, {
                    Messages: next, HeadId: messages[messages.length-1].id
                });
            });
            setIsRunning(false);
        },
        onReload: async (a, b) => {

            const id = generateId();


            setThreads((prev) => {


                const thread = prev.get(currentThreadId);

                const next = [...thread.Messages, {
                    id,
                    role: "assistant",
                    status: {type: "running"},
                    content:  [],
                    metadata: {},
                    parentId: b.parentId
                } as ThreadMessageLike];

                return new Map(prev).set(currentThreadId, {
                    Messages: next, HeadId: id
                });
            });

            setIsRunning(true);

            const reply = await onReload(b);

            var messages = reply.messages.map((t) => ({...t, id: t.messageId, metadata: {}, attachments: [], ...t.additionalProperties, parentId: b.parentId, content: t.contents.map((t) => {
                    if (t.$type == "text") {
                        return {type: "text", text: t.text};
                    }
                    return {};
                })}));

            setThreads((prev) => {

                const thread = prev.get(currentThreadId) ?? { Messages: [], HeadId: null };

                const next = [...thread.Messages.filter((t) => t.id != id), ...messages ];
                return new Map(prev).set(currentThreadId, {
                    Messages: next, HeadId: messages[messages.length-1].id
                });
            });
            setIsRunning(false);
        },
        adapters: {
            threadList: threadListAdapter,
        },
        messageRepository: {
            messages: (threads.get(currentThreadId) || {Messages: [], HeadId: null}).Messages.map((t) => ({message: {...t, status: t.status || "complete"} as ThreadMessageLike, parentId: t.parentId})),
            headId: threads.get(currentThreadId)?.HeadId,
        } as ExportedMessageRepository
    });

    if (!isModal) {
        return  <AssistantRuntimeProvider runtime={runtime}>
            <ThreadList />
            <Thread />
        </AssistantRuntimeProvider>
    }
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <AssistantModal/>
        </AssistantRuntimeProvider>
    );
}
/*
const client = new QapiClient("https://politiloggen.qapio.com");


client.Source("Qapiq_Assistant.Connect({})").subscribe((t) => {
  console.log(t);
});
*/




export const Inner = connect((qapi) => qapi.Source("Qapiq_Assistant.Connect({})"), (qapi) => {
    return {
        onNext: (payload) => qapi.InvokeAsync("OnNext")(payload),
        onReload: (payload) => qapi.InvokeAsync("Reload")(payload),
       // threads: qapi.Source("Context.GetThreads({})"),
        onCreateThread: (payload) => qapi.InvokeAsync("CreateThread")(payload),
        onSwitchThread: (payload) => qapi.InvokeAsync("SwitchThread")(payload),
        onArchiveThread: (payload) => qapi.InvokeAsync("ArchiveThread")(payload),

    }
}, ({useAssistant}) => {
    useAssistant("Qapiq");
})(({threads, onNext, onReload, onCreateThread, onSwitchThread, onArchiveThread, isModal = false}) => {

        if (!threads) {
            return;
        }

        return <ThreadProvider onArchiveThread={onArchiveThread} onSwitchThread={onSwitchThread} onCreateThread={onCreateThread} onReload={onReload} onNext={onNext} currentThreadId={threads.CurrentThreadId} threads={threads.Threads}>
            <ChatWithThreads isModal={isModal} />
        </ThreadProvider>

    }
);

export const App = () => {
    return <QapiContext.Provider value={{ client: new QapiClient("http://127.0.0.1:2020", "FridtjofSession1") }}><Inner/></QapiContext.Provider>
};



