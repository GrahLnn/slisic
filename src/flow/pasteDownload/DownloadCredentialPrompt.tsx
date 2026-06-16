import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { sileo } from "sileo";
import { deps, listenDownloadTaskChanged } from "./events";
import {
  applyCredentialTaskChange,
  credentialPromptRequestFromDownloadTask,
  type DownloadCredentialPromptRequest,
} from "./core";

function YoutubeCookiePromptContent({
  reason,
  onSubmit,
}: {
  reason: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!value.trim()) {
      setError("Paste YouTube cookies first.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <form
      className="fixed right-5 bottom-5 z-[1000] flex w-[min(520px,calc(100vw-40px))] flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
      onSubmit={submit}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-amber-300">YouTube cookies needed</h2>
        <p className="text-xs leading-4 text-zinc-300">
          Paste exported YouTube cookies in Netscape cookie format. The download will continue after
          the cookie file is saved locally.
        </p>
      </div>
      <p className="text-xs leading-4 text-amber-200/90">{reason}</p>
      <label className="sr-only" htmlFor="youtube-cookies-input">
        Paste exported YouTube cookies in Netscape cookie format. The download will continue after
        the cookie file is saved locally.
      </label>
      <textarea
        id="youtube-cookies-input"
        autoComplete="off"
        className="h-28 w-full resize-none rounded-md border border-zinc-600 bg-zinc-950/70 p-2 font-mono text-xs text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-amber-400 focus:ring-2 focus:ring-amber-400/25"
        placeholder="Paste cookies.txt content here"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
      {error ? <p className="text-xs leading-4 text-red-300">{error}</p> : null}
      <button
        type="submit"
        disabled={submitting}
        className="mt-1 w-fit rounded-md bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {submitting ? "Saving" : "Continue Download"}
      </button>
    </form>
  );
}

export function DownloadCredentialPrompt() {
  const [taskRequests, setTaskRequests] = useState<DownloadCredentialPromptRequest[]>([]);
  const [submittedTaskIds, setSubmittedTaskIds] = useState<Set<string>>(() => new Set());
  const activeToastIdRef = useRef<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void deps
      .listDownloadTasks()
      .then((tasks) => {
        if (cancelled) {
          return;
        }
        setTaskRequests(
          tasks.flatMap((task) => credentialPromptRequestFromDownloadTask(task) ?? []),
        );
      })
      .catch((error) => {
        console.error("Failed to load download credential requests", error);
      });

    void listenDownloadTaskChanged((payload) => {
      setTaskRequests((requests) => applyCredentialTaskChange(requests, payload));
      if (payload.status === "awaiting_credentials") {
        setSubmittedTaskIds((taskIds) => {
          if (!taskIds.has(payload.task_id)) {
            return taskIds;
          }
          const nextTaskIds = new Set(taskIds);
          nextTaskIds.delete(payload.task_id);
          return nextTaskIds;
        });
      }
    })
      .then((unsubscribe) => {
        if (cancelled) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
      })
      .catch((error) => {
        console.error("Failed to subscribe to download credential requests", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const credentialRequest = useMemo(
    () => taskRequests.find((request) => !submittedTaskIds.has(request.taskId)) ?? null,
    [submittedTaskIds, taskRequests],
  );

  useEffect(() => {
    const taskId = credentialRequest?.taskId ?? null;
    if (!credentialRequest || !taskId || activeTaskIdRef.current === taskId) {
      return;
    }

    if (activeToastIdRef.current) {
      sileo.dismiss(activeToastIdRef.current);
    }

    activeTaskIdRef.current = taskId;
    activeToastIdRef.current = sileo.warning({
      title: "YouTube cookies needed",
      description: "Paste YouTube cookies in the prompt to continue the download.",
      duration: 8000,
    });
  }, [credentialRequest]);

  useEffect(() => {
    if (credentialRequest) {
      return;
    }
    if (activeToastIdRef.current) {
      sileo.dismiss(activeToastIdRef.current);
      activeToastIdRef.current = null;
      activeTaskIdRef.current = null;
    }
  }, [credentialRequest]);

  if (!credentialRequest) {
    return null;
  }

  return (
    <YoutubeCookiePromptContent
      reason={credentialRequest.request.reason}
      onSubmit={async (cookies) => {
        await deps.submitYoutubeCookiesAndResumeDownloadTask(credentialRequest.taskId, cookies);
        setSubmittedTaskIds((taskIds) => new Set(taskIds).add(credentialRequest.taskId));
        setTaskRequests((requests) =>
          requests.filter((request) => request.taskId !== credentialRequest.taskId),
        );
        if (activeToastIdRef.current) {
          sileo.dismiss(activeToastIdRef.current);
        }
        activeToastIdRef.current = null;
        activeTaskIdRef.current = null;
      }}
    />
  );
}
