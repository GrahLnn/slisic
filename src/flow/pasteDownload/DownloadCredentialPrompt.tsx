import { useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { hook } from "./api";
import { deps } from "./events";

function YoutubeCookiePromptContent({ onSubmit }: { onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
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
    <div className="flex w-full flex-col gap-2">
      <p className="text-xs leading-4">
        Paste exported YouTube cookies in Netscape cookie format. The download will continue after
        the cookie file is saved locally.
      </p>
      <textarea
        autoComplete="off"
        className="h-28 w-full resize-none rounded-md border border-black/10 bg-white/80 p-2 font-mono text-xs text-black outline-none dark:border-white/10 dark:bg-black/30 dark:text-white"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
      {error ? <p className="text-xs leading-4 text-red-500">{error}</p> : null}
      <button
        type="button"
        disabled={submitting}
        className="mt-1 w-fit rounded-full bg-black/10 px-3 py-1 text-xs font-medium text-black transition hover:bg-black/15 disabled:opacity-50 dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
        onClick={() => {
          void submit();
        }}
      >
        {submitting ? "Saving" : "Continue"}
      </button>
    </div>
  );
}

export function DownloadCredentialPrompt() {
  const { items } = hook.useContext();
  const activeToastIdRef = useRef<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);

  const credentialItem = useMemo(
    () =>
      items.find(
        (item) =>
          item.status === "awaiting_credentials" &&
          item.taskId &&
          item.credentialRequest?.provider === "youtube",
      ) ?? null,
    [items],
  );

  useEffect(() => {
    const taskId = credentialItem?.taskId ?? null;
    if (!credentialItem || !taskId || activeTaskIdRef.current === taskId) {
      return;
    }

    if (activeToastIdRef.current) {
      sileo.dismiss(activeToastIdRef.current);
    }

    activeTaskIdRef.current = taskId;
    activeToastIdRef.current = sileo.warning({
      title: "YouTube cookies needed",
      description: (
        <YoutubeCookiePromptContent
          onSubmit={async (cookies) => {
            await deps.submitYoutubeCookiesAndResumeDownloadTask(taskId, cookies);
            if (activeToastIdRef.current) {
              sileo.dismiss(activeToastIdRef.current);
            }
            activeToastIdRef.current = null;
            activeTaskIdRef.current = null;
          }}
        />
      ),
      duration: null,
    });
  }, [credentialItem]);

  useEffect(() => {
    if (credentialItem) {
      return;
    }
    if (activeToastIdRef.current) {
      sileo.dismiss(activeToastIdRef.current);
      activeToastIdRef.current = null;
      activeTaskIdRef.current = null;
    }
  }, [credentialItem]);

  return null;
}
