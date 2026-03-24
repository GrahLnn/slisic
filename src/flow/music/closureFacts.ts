import type { ClosureLifecycleFact } from "@/src/cmd/commands";
import { createClosureEventContract } from "./store.identity";
import type { ClosureEventContract, ClosureEventPhase } from "./store.types";

type BackendPhase = ClosureLifecycleFact["phase"];
type PersistedClosureEventPhase = Extract<
	ClosureEventPhase,
	"saved" | "downloaded" | "analyzed" | "failed"
>;

const BACKEND_PHASE_TO_EVENT_PHASE = {
	Saved: "saved",
	Downloaded: "downloaded",
	Analyzed: "analyzed",
	Failed: "failed",
} as const satisfies Record<BackendPhase, PersistedClosureEventPhase>;

export function toClosureEventPhase(
	phase: BackendPhase,
): PersistedClosureEventPhase {
	return BACKEND_PHASE_TO_EVENT_PHASE[phase];
}

export function expandClosureLifecycleFact(
	fact: ClosureLifecycleFact,
): ClosureEventContract[] {
	const primary = createClosureEventContract(
		fact.owner_session_id,
		fact.entry_identity,
		toClosureEventPhase(fact.phase),
	);

	if (fact.phase === "Analyzed" && fact.notification_text) {
		return [
			primary,
			createClosureEventContract(
				fact.owner_session_id,
				fact.entry_identity,
				"notified",
			),
		];
	}

	return [primary];
}

export function expandClosureLifecycleFacts(
	facts: readonly ClosureLifecycleFact[],
): ClosureEventContract[] {
	return facts.flatMap(expandClosureLifecycleFact);
}
