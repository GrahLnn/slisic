import { AnimatePresence, motion } from "motion/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { labels } from "@/src/components/labels";
import { cn, os } from "@/lib/utils";
import { motionIcons } from "@/src/assets/icons";
import { action, hook } from "@/src/flow/music";
import { EmptyPage } from "@/src/components/empty";
import { New } from "@/src/components/music/new";
import { BackButton } from "@/src/components/uni";
import { useCursorInApp } from "@/src/flow/cursorInApp";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
	LongPressContextMenuItem,
} from "@/components/ui/context-menu";
import { projectWorkspaceScreen } from "@/src/flow/music/store";

export function projectPlaylistHint(
	processHint: ReturnType<typeof hook.useProcessHint>,
	playlistName: string,
): string | null {
	return processHint?.playlistName === playlistName ? processHint.text : null;
}

export function closureProjectionLabel(
	closure: ReturnType<typeof hook.useClosureProjection>,
): string | null {
	if (closure.state === "blocked") {
		return closure.notificationText;
	}
	if (closure.state === "pending_download") {
		return "Waiting for download";
	}
	if (closure.state === "pending_analysis") {
		return "Waiting for analysis";
	}
	if (closure.state === "notification_missing") {
		return "Ready in machine state; notification missing";
	}
	if (closure.state === "ready") {
		return "Ready for playback";
	}
	if (closure.state === "playable") {
		return closure.notificationText ?? "Playable";
	}
	return null;
}

export function shouldRenderHomeRoute(
	ctx: Pick<ReturnType<typeof hook.useContext>, "routeResolved">,
): boolean {
	return ctx.routeResolved;
}

export function Face({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-start overflow-hidden select-none">
			{children}
		</div>
	);
}

function Play() {
	const lists = hook.useList();
	const ctx = hook.useContext();
	const isPlaying = hook.useIsPlaying();
	const curPlay = hook.useCurPlay();
	const requestedPlay = hook.useRequestedPlay();
	const confirmedPlay = hook.useConfirmedPlay();
	const curList = hook.useCurList();
	const isCursorInApp = useCursorInApp();
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
	const didInitCenterRef = useRef(false);
	const processHint = hook.useProcessHint();
	const closure = hook.useClosureProjection();
	const hintForPlaylist = (playlistName: string) =>
		projectPlaylistHint(processHint, playlistName);
	const closureLabel = closureProjectionLabel(closure);
	const hasPlaybackSurface = ctx.mode === "play" && closure.interactive && !!curList;
	const displayLists =
		lists.length > 0
			? lists.map((playlist) => ({
					name: playlist.name,
					playlist,
					isHydrated: true,
					historicalTitle:
						playlist.name === curList?.name
							? confirmedPlay?.title ?? requestedPlay?.title ?? null
							: null,
					activeTitle:
						playlist.name === curList?.name ? confirmedPlay?.title ?? null : null,
				}))
			: ctx.loading
				? ctx.playlists.map((playlist) => ({
						name: playlist.name,
						playlist: null,
						isHydrated: false,
						historicalTitle: null,
						activeTitle: null,
					}))
				: [];

	const setItemRef = useCallback(
		(key: string): React.RefCallback<HTMLDivElement> =>
			(el) => {
				if (el) itemRefs.current[key] = el;
				else delete itemRefs.current[key];
			},
		[],
	);

	useLayoutEffect(() => {
		const key = curList?.name ?? null;
		if (key == null) {
			if (didInitCenterRef.current || displayLists.length === 0) return;
			didInitCenterRef.current = true;
			// Entering play page without selection: center the first visible playlist (top -> bottom).
			const firstKey = displayLists[0].name;
			const firstEl = itemRefs.current[firstKey];
			if (!firstEl || !containerRef.current) return;
			requestAnimationFrame(() =>
				firstEl.scrollIntoView({ block: "center", behavior: "auto" }),
			);
			return;
		}

		const el = itemRefs.current[key];
		const wrap = containerRef.current;
		if (!el || !wrap) return;

		requestAnimationFrame(() =>
			el.scrollIntoView({ block: "center", behavior: "smooth" }),
		);
	}, [curList, displayLists]);

	return (
		<Face>
			<div className="z-10 flex h-full w-full flex-col">
				<div
					ref={containerRef}
					className={cn([
						"h-screen w-screen snap-y snap-mandatory flex flex-col items-center gap-8",
						isPlaying ? "overflow-hidden" : "overflow-y-scroll",
					])}
				>
					<div aria-hidden className="h-[100vh] shrink-0 snap-none" />

					{displayLists.map(
						({ name, playlist, isHydrated, historicalTitle, activeTitle }) => {
						const isCurrent = name === curList?.name;
						const disabled =
							(!closure.interactive && isCurrent) ||
							(hasPlaybackSurface && !isCurrent) ||
							(!isHydrated && ctx.loading);
						const shouldSwap = hasPlaybackSurface && isCurrent;
						const showName = shouldSwap ? hoveredKey === name : true;
						const isOk = playlist
							? playlist.entries.every((entry) => entry.downloaded_ok)
							: true;

						const alt = historicalTitle ?? name;
						const longer =
							(alt?.length ?? 0) >= name.length ? alt : name;

						return (
							<motion.div
								key={name}
								ref={setItemRef(name)}
								className={cn([
									"snap-center text-2xl font-cinzel text-[#0a0a0a] dark:text-[#fafafa] transition focus:outline-none flex flex-col items-center",
									disabled && "pointer-events-none select-none",
								])}
								initial={false}
								animate={
									disabled
										? { filter: "blur(6px)", opacity: 0 }
										: { filter: "blur(0px)", opacity: 1 }
								}
								transition={{ duration: 0.3, ease: "easeOut" }}
								tabIndex={disabled ? -1 : 0}
								aria-disabled={disabled || undefined}
							>
								<ContextMenu>
									<ContextMenuTrigger
										className={cn([
											isOk
												? "cursor-pointer whitespace-nowrap"
												: "select-none text-[#404040] dark:text-[#a3a3a3] animate-pulse",
										])}
										onMouseEnter={() => setHoveredKey(name)}
										onMouseLeave={() =>
											setHoveredKey((key) =>
												key === name ? null : key,
											)
										}
										onClick={() => {
											if (disabled || !isOk || !playlist) return;
											void action.play(playlist);
										}}
										onContextMenu={(event) => {
											if (isPlaying || disabled || !isOk) {
												event.preventDefault();
											}
										}}
									>
										{shouldSwap ? (
											<span className="relative inline-block">
												<span
													aria-hidden
													className="invisible block max-w-[66vw] whitespace-nowrap"
												>
													{longer}
												</span>

												<AnimatePresence mode="wait" initial={false}>
													{showName ? (
													<motion.span
														key="name"
															className="pointer-events-none absolute inset-0 flex items-center overflow-hidden"
															initial={{ filter: "blur(6px)", opacity: 0 }}
															animate={{ filter: "blur(0px)", opacity: 1 }}
															exit={{ filter: "blur(6px)", opacity: 0 }}
															transition={{ duration: 0.25, ease: "easeOut" }}
														>
															<span className="mx-auto max-w-[66vw] truncate whitespace-nowrap">
																{name}
															</span>
														</motion.span>
													) : (
														<motion.span
															key="title"
															className="pointer-events-none absolute inset-0 flex items-center overflow-hidden"
															initial={{ filter: "blur(6px)", opacity: 0 }}
															animate={{ filter: "blur(0px)", opacity: 1 }}
															exit={{ filter: "blur(6px)", opacity: 0 }}
															transition={{ duration: 0.25, ease: "easeOut" }}
														>
															<span className="mx-auto max-w-[66vw] truncate whitespace-nowrap">
																{alt}
															</span>
														</motion.span>
													)}
												</AnimatePresence>
											</span>
										) : (
											<span className="relative inline-block">
												<span>{name}</span>
										{hintForPlaylist(name) ? (
													<span className="absolute ml-1 max-w-2xs truncate whitespace-nowrap text-xs text-[#262626] dark:text-[#d4d4d4]">
												- {hintForPlaylist(name)}
													</span>
										) : isCurrent && closureLabel ? (
											<span className="absolute ml-1 max-w-2xs truncate whitespace-nowrap text-xs text-[#262626] dark:text-[#d4d4d4]">
												- {closureLabel}
											</span>
												) : null}
												{isCurrent && activeTitle ? (
													<span className="absolute ml-1 max-w-2xs truncate whitespace-nowrap text-xs text-[#262626] dark:text-[#d4d4d4]">
														- {activeTitle}
													</span>
												) : isCurrent && historicalTitle ? (
													<span className="absolute ml-1 max-w-2xs truncate whitespace-nowrap text-xs text-[#525252] dark:text-[#a3a3a3]">
														- {historicalTitle}
													</span>
												) : null}
												{playlist && !isOk ? (
													<span className="absolute bottom-0 ml-1 text-xs text-[#404040] dark:text-[#a3a3a3]">
														{
															playlist.entries.filter(
																(entry) => !entry.downloaded_ok,
															).length
														}
													</span>
												) : null}
											</span>
										)}
									</ContextMenuTrigger>
									{!isPlaying && !disabled && isOk && playlist ? (
										<ContextMenuContent
											className={cn([
												"bg-[rgba(255, 255, 255, 0.05)] border-none",
												os.is("macos")
													? "backdrop-blur-[3px] shadow-md"
													: "gl gl-shadow",
											])}
										>
											<ContextMenuItem
												className="focus:bg-accent/30 flex items-center justify-between transition dark:text-[#e5e5e5]"
												onClick={() => action.edit(playlist)}
											>
												Edit
											</ContextMenuItem>
											<LongPressContextMenuItem
												durationMs={2000}
												onConfirm={() => void action.delete(playlist)}
												className="focus:bg-accent/30 text-[#e81123] focus:text-[#e81123] data-[highlighted]:text-[#e81123]"
											>
												Delete
											</LongPressContextMenuItem>
										</ContextMenuContent>
									) : null}
								</ContextMenu>

								<AnimatePresence>
									{curPlay && isPlaying && isCursorInApp && isCurrent ? (
										<div>
											<span
												aria-hidden
												className="invisible block h-0 max-w-[66vw] whitespace-nowrap"
											>
												{longer}
											</span>
											<motion.div
												className="flex w-full min-w-24 justify-between gap-4"
												initial={{ filter: "blur(6px)", opacity: 0, height: 0 }}
												animate={{
													filter: "blur(0px)",
													opacity: 1,
													height: "auto",
												}}
												exit={{ filter: "blur(6px)", opacity: 0, height: 0 }}
											>
												<div className="flex items-center">
													<motion.div
														className={cn([
															"relative transition duration-300 hover:text-[#468be6]",
															"hover:opacity-100 opacity-40",
															ctx.nowJudge === "Up" &&
																"text-[#468be6] opacity-100",
															ctx.nowJudge === "Down" &&
																"pointer-events-none opacity-0",
														])}
														onClick={() =>
															ctx.nowJudge === "Up"
																? void action.cancleUp(curPlay)
																: void action.up(curPlay)
														}
														animate={{
															width: ctx.nowJudge === "Down" ? 0 : "auto",
														}}
													>
														<AnimatePresence mode="wait" initial={false}>
															{ctx.nowJudge === "Up" ? (
																<motionIcons.thumbsUpSolid
																	initial={{ pathLength: 0 }}
																	animate={{ pathLength: 1 }}
																	exit={{ pathLength: 0 }}
																/>
															) : (
																<motionIcons.thumbsUp
																	initial={{ pathLength: 0 }}
																	animate={{ pathLength: 1 }}
																	exit={{ pathLength: 0 }}
																/>
															)}
														</AnimatePresence>
													</motion.div>

													<motion.div
														initial={{
															width: ctx.nowJudge === "Down" ? 0 : 24,
														}}
														animate={{
															width: ctx.nowJudge === "Down" ? 0 : 24,
														}}
													/>

													<motion.div
														className={cn([
															"mt-1 p-1 transition duration-300",
															"hover:opacity-60 opacity-40",
															ctx.nowJudge === "Down" && "opacity-80",
															ctx.nowJudge === "Up" &&
																"pointer-events-none opacity-0",
														])}
														onClick={() => {
															if (ctx.nowJudge === "Down") {
																void action.cancleDown(curPlay);
															} else {
																void action.down(curPlay);
															}
														}}
													>
														<AnimatePresence mode="wait" initial={false}>
															{ctx.nowJudge === "Down" ? (
																<motionIcons.thumbsDownSolid
																	initial={{ pathLength: 0 }}
																	animate={{ pathLength: 1 }}
																	exit={{ pathLength: 0 }}
																/>
															) : (
																<motionIcons.thumbsDown
																	initial={{ pathLength: 0 }}
																	animate={{ pathLength: 1 }}
																	exit={{ pathLength: 0 }}
																/>
															)}
														</AnimatePresence>
													</motion.div>
												</div>

												<div className="flex items-center">
													<div
														className={cn([
															"mt-[2px] p-1 transition duration-300",
															"hover:opacity-60 opacity-40",
															"hover:text-[#e81123] dark:hover:text-[#e3303f]",
														])}
														onClick={() => void action.unstar(curPlay)}
													>
														<motionIcons.starSlash
															size={14}
															initial={{ pathLength: 1 }}
														/>
													</div>
												</div>
											</motion.div>
										</div>
									) : null}
								</AnimatePresence>
							</motion.div>
						);
						},
					)}

					{!isPlaying ? (
						<motion.div
							className={cn([
								"snap-center cursor-pointer whitespace-nowrap text-2xl font-cinzel text-[#0a0a0a] transition dark:text-[#fafafa]",
							])}
							onClick={() => {
								if (isPlaying) return;
								action.addNew();
							}}
							tabIndex={isPlaying ? -1 : 0}
							aria-disabled={isPlaying || undefined}
						>
							Add List
						</motion.div>
					) : null}

					<div aria-hidden className="h-[50vh] shrink-0 snap-none" />
				</div>
			</div>
		</Face>
	);
}

function WorkspaceEditor() {
	const isReview = hook.useIsReview();
	return (
		<Face>
			<div className="relative flex h-full w-full overflow-hidden">
				<div
					className={cn([
						"absolute left-6 top-0 flex items-center gap-2 transition",
						isReview && "pointer-events-none opacity-0",
					])}
				>
					<BackButton onClick={action.back} />
				</div>

				<div className="flex w-1/2 flex-col items-center justify-center">
					<motion.div layoutId="musicPlus">
						<labels.musicPlus />
					</motion.div>
				</div>

				<div className="w-1/2 overflow-y-auto px-6 py-4">
					<motion.div
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.5 }}
					>
						<New />
					</motion.div>
				</div>
			</div>
		</Face>
	);
}

function Guide() {
	return (
		<EmptyPage
			symbol={
				<motion.div layoutId="musicPlus">
					<labels.musicPlus />
				</motion.div>
			}
			explain="You don’t have any play list yet. Let’s add your first one!"
			cta="Add First List"
			onClick={action.addNew}
		/>
	);
}

export default function Home() {
	const ctx = hook.useContext();
	if (!shouldRenderHomeRoute(ctx)) {
		return null;
	}

	return {
		play: <Play />,
		guide: <Guide />,
		create: <WorkspaceEditor />,
		edit: <WorkspaceEditor />,
		unresolved: null,
	}[projectWorkspaceScreen(ctx)] ?? null;
}
