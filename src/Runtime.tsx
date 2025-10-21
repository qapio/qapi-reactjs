
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

type MessageCommonProps = {
  readonly id: string;
  readonly createdAt: Date;
};

type ThreadMessageLike = ThreadBase & MessageCommonProps & {id: string, parentId: string | null, status: MessageStatus | undefined, metadata: any | undefined};

type Thread = {messages: ThreadMessageLike[], headId: string | null}


const ThreadContext = createContext<{
  currentThreadId: string;
  setCurrentThreadId: (id: string) => void;
  threads: Map<string, Thread>;
  setThreads: React.Dispatch<
    React.SetStateAction<Map<string, Thread>>
  >;
}>({
  currentThreadId: "default",
  setCurrentThreadId: () => {},
  threads: new Map(),
  setThreads: () => {},
});

// Thread provider component
export function ThreadProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<Map<string, Thread>>(
    new Map<string, Thread>([["default", {messages: [
     /*   {id: "A", role: "user", content: [{type: "text", text: "HELO"}], attachments: []},
        {id: "A1", role: "assistant", content: [{type: "text", text: "HELOasd"}], attachments: [],metadata: {}, parentId: "A"},
        {id: "A2", role: "assistant", content: [{type: "text", text: "HELaaO"}], attachments: [], metadata: {}, parentId: "A"}*/
      ] as ThreadMessageLike[], headId: null}]]),
  );
  const [currentThreadId, setCurrentThreadId] = useState("default");

  return (
    <ThreadContext.Provider
      value={{ currentThreadId, setCurrentThreadId, threads, setThreads }}
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

export function ChatWithThreads() {
  const { currentThreadId, setCurrentThreadId, threads, setThreads } =
    useThreadContext();
  const [threadList, setThreadList] = useState<ExternalStoreThreadData<any>[]>([
    { id: "default", status: "regular", title: "New Chat" },
  ]);

  const [isRunning, setIsRunning] = useState(false);


  const threadListAdapter: ExternalStoreThreadListAdapter = {
    threadId: currentThreadId,
    threads: threadList.filter((t) => t.status === "regular"),
    archivedThreads: threadList.filter((t) => t.status === "archived"),

    onSwitchToNewThread: () => {
      console.log("ÆHA*!")
      const newId = `thread-${Date.now()}`;
      setThreadList((prev) => [
        ...prev,
        {
          id: newId,
          status: "regular",
          title: "New Chat",
        },
      ]);
      setThreads((prev) => new Map(prev).set(newId, {messages: [], headId: null}));
      setCurrentThreadId(newId);
    },

    onSwitchToThread: (threadId) => {
      console.log("A")
      setCurrentThreadId(threadId);
    },

    onRename: (threadId, newTitle) => {
      setThreadList((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, title: newTitle } : t,
        ),
      );
    },

    onArchive: (threadId) => {
      console.log("SØHÆ!")
      setThreadList((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, status: "archived" } : t,
        ),
      );
    },

    onDelete: (threadId) => {
      console.log("SHÆ!")
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
      setThreads((prev) => {
        const thread = prev.get(currentThreadId) ?? { messages: [], headId: null };

        console.log(messages, "ED!")
        return new Map(prev).set(currentThreadId, {
          messages: thread.messages,
          headId: messages[messages.length - 1].id
        });
      });
    },
    onNew: async (message: AppendMessage) => {
      console.log(message, "A")
      const id1 = generateId();

      setThreads((prev) => {


        const thread = prev.get(currentThreadId) ?? { messages: [], headId: null };

        const next = [...thread.messages, {
          ...message,
          id: id1
        } as ThreadMessageLike];

        return new Map(prev).set(currentThreadId, {
          messages: next, headId: id1
        });
      });

      setIsRunning(true);
      await new Promise(r => setTimeout(r, 2000));
      setIsRunning(false);
      const id = generateId();


      setThreads((prev) => {

        const thread = prev.get(currentThreadId) ?? { messages: [], headId: null };

        const next = [...thread.messages, {
          ...message,
          id,
          role: "assistant",
          content: [{ type: "text", text: "My response"+generateId() }],
          parentId: id1
        } as ThreadMessageLike ];
        return new Map(prev).set(currentThreadId, {
          messages: next, headId: id
        });
      });
      setIsRunning(false);
    },
    onEdit: async (m) => {
      const id = generateId();
      setThreads((prev) => {


        const thread = prev.get(currentThreadId);

        const next = [...thread.messages, {...m, id} as ThreadMessageLike];

        return new Map(prev).set(currentThreadId, {
          messages: next, headId: id
        });
      });

      setIsRunning(true);

      await new Promise(r => setTimeout(r, 2000));

      setThreads((prev) => {

        const thread = prev.get(currentThreadId) ?? { messages: [], headId: null };

        const is = generateId();

        const next = [...thread.messages, {
          ...m,
          id: is,
          createdAt: new Date(),
          role: "assistant",
          content: [{ type: "text", text: "My response"+generateId() }],
          metadata: {},
          parentId: id
        } as ThreadMessageLike ];
        return new Map(prev).set(currentThreadId, {
          messages: next, headId: is
        });
      });
      setIsRunning(false);
    },
    onReload: async (a, b) => {
      const id = generateId();
      setThreads((prev) => {


        const thread = prev.get(currentThreadId);



        const next = [...thread.messages, {
          id,
          role: "assistant",
          status: {type: "running"},
          content:  [],
          metadata: {},
          parentId: b.parentId
        } as ThreadMessageLike];

        return new Map(prev).set(currentThreadId, {
          messages: next, headId: id
        });
      });

      setIsRunning(true);

      await new Promise(r => setTimeout(r, 2000));

      setThreads((prev) => {

        const thread = prev.get(currentThreadId) ?? { messages: [], headId: null };

        const next = [...thread.messages.filter((t) => t.id != id), {
          id,
          createdAt: new Date(),
          role: "assistant",
          content: [{ type: "text", text: "My response"+generateId() }],
          metadata: {},
          parentId: b.parentId,
        } as ThreadMessageLike ];
        return new Map(prev).set(currentThreadId, {
          messages: next, headId: id
        });
      });
      setIsRunning(false);
    },
    adapters: {
      threadList: threadListAdapter,
    },
    messageRepository: {
      messages: (threads.get(currentThreadId) || {messages: [], headId: null}).messages.map((t) => ({message: {...t, status: t.status || "complete"} as ThreadMessageLike, parentId: t.parentId})),
      headId: threads.get(currentThreadId)?.headId,
    } as ExportedMessageRepository
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadList />
      <Thread />
    </AssistantRuntimeProvider>
  );
}
/*
const client = new QapiClient("https://politiloggen.qapio.com");


client.Source("Qapiq_Assistant.Connect({})").subscribe((t) => {
  console.log(t);
});
*/






  export const App = connect((qapi) => qapi.Source("Qapiq_Assistant.Connect({})").pipe(map((t) => JSON.parse(t))))((props) => {

      return <QapiContext.Provider value={{ host: "https://politiloggen.qapio.com" }}>
        <ThreadProvider>
          <ChatWithThreads />
        </ThreadProvider>
      </QapiContext.Provider>;
    }
  );



