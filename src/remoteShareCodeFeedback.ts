export type RemoteShareCodeFeedback = {
  tone: "error" | "warning";
  title: string;
  description: string;
};

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function remoteShareCodeFeedback(error: unknown): RemoteShareCodeFeedback {
  switch (errorMessage(error)) {
    case "remote_code_occupied":
      return {
        tone: "error",
        title: "Connection code is already in use",
        description: "The previous connection code is unchanged.",
      };
    case "remote_code_network_required":
      return {
        tone: "warning",
        title: "Connect to the internet to verify this code",
        description: "The previous connection code is unchanged.",
      };
    case "remote_code_identity_rejected":
      return {
        tone: "error",
        title: "Could not verify this device",
        description: "The previous connection code is unchanged.",
      };
    default:
      return {
        tone: "error",
        title: "Could not update connection code",
        description: "The previous connection code is unchanged.",
      };
  }
}
