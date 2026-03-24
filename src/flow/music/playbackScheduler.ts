export type PlaybackMode = "play" | "create" | "edit" | "new_guide";

export interface PlaybackContextSnapshot {
	mode: PlaybackMode;
	selectedListName?: string | null;
	playbackListName?: string | null;
}

export interface PlaybackScheduleHandle {
	cancel(): void;
}

export type PlaybackScheduleTask = (signal: AbortSignal) => Promise<void>;

export class PlaybackScheduler {
	private epoch = 0;
	private activeController: AbortController | null = null;
	private disposed = false;

	bumpEpoch(): number {
		this.epoch += 1;
		return this.epoch;
	}

	getEpoch(): number {
		return this.epoch;
	}

	markDisposed(): void {
		this.disposed = true;
		this.cancelCurrent();
		this.bumpEpoch();
	}

	markActive(): void {
		this.disposed = false;
	}

	isActive(
		epoch: number,
		snapshot: PlaybackContextSnapshot,
		expectedListName?: string,
	): boolean {
		if (this.disposed) return false;
		if (epoch !== this.epoch) return false;
		if (snapshot.mode !== "play") return false;
		const activeListName =
			snapshot.playbackListName ?? snapshot.selectedListName ?? null;
		if (!activeListName) return false;
		if (expectedListName && activeListName !== expectedListName) {
			return false;
		}
		return true;
	}

	cancelCurrent(): void {
		const current = this.activeController;
		this.activeController = null;
		current?.abort();
	}

	replaceWith(task: PlaybackScheduleTask, epoch: number): PlaybackScheduleHandle | null {
		if (this.disposed || epoch !== this.epoch) return null;

		this.cancelCurrent();
		const controller = new AbortController();
		this.activeController = controller;

		void task(controller.signal).finally(() => {
			if (this.activeController === controller) {
				this.activeController = null;
			}
		});

		return {
			cancel: () => {
				if (this.activeController === controller) {
					this.activeController = null;
				}
				controller.abort();
			},
		};
	}
}
