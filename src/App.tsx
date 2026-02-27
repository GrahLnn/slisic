import { cn } from "@/lib/utils";
import "./App.css";
import "sileo/styles.css";
import "@fontsource/maple-mono";
import { useMemo } from "react";
import Input from "./components/Input";
import TopBar from "./topbar";
import { type DemoStats, type TaskStatus } from "./cmd/templateApp";
import { Toaster } from "sileo";
import { action, hook } from "./flow/template_board";
import { me } from "@grahlnn/fn";
import { useAppBootstrap } from "./flow/bootstrap";

const statusOptions: TaskStatus[] = ["todo", "doing", "done"];

const statusStyles: Record<TaskStatus, string> = {
  todo: "bg-slate-500/10 text-slate-700 dark:text-slate-200 border-slate-500/30",
  doing:
    "bg-amber-500/10 text-amber-700 dark:text-amber-200 border-amber-500/30",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200 border-emerald-500/30",
};

const statusLabels: Record<TaskStatus, string> = {
  todo: "To Do",
  doing: "Doing",
  done: "Done",
};

const statColors = [
  "from-cyan-500/20 via-cyan-500/5 to-transparent",
  "from-fuchsia-500/20 via-fuchsia-500/5 to-transparent",
  "from-amber-500/20 via-amber-500/5 to-transparent",
  "from-lime-500/20 via-lime-500/5 to-transparent",
  "from-emerald-500/20 via-emerald-500/5 to-transparent",
];

function StatsPanel({ stats }: { stats: DemoStats }) {
  const cards = [
    { label: "Members", value: stats.total_members },
    { label: "Tasks", value: stats.total_tasks },
    { label: "To Do", value: stats.todo_tasks },
    { label: "Doing", value: stats.doing_tasks },
    { label: "Done", value: stats.done_tasks },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map((card, index) => (
        <div
          key={card.label}
          className={cn(
            "rounded-xl border border-white/20 dark:border-white/10",
            "px-4 py-3 bg-[var(--card-bg)]",
            "relative overflow-hidden",
          )}
        >
          <div
            className={cn(
              "absolute inset-0 -z-10 pointer-events-none bg-gradient-to-br",
              statColors[index % statColors.length],
            )}
          />
          <p className="text-xs uppercase tracking-[0.14em] opacity-70">
            {card.label}
          </p>
          <p className="text-2xl font-semibold mt-1">{card.value}</p>
        </div>
      ))}
    </div>
  );
}

function TemplateBoard() {
  const state = hook.useState();
  const {
    dashboard,
    memberInput,
    taskInput,
    bulkStatus,
    selectedTaskIds,
    mouseInfo,
  } = hook.useContext();
  const loading = state === "loading";

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of dashboard?.members ?? []) {
      map.set(member.id, `${member.name} (${member.role})`);
    }
    return map;
  }, [dashboard?.members]);

  const assignmentMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const assignment of dashboard?.assignments ?? []) {
      map.set(assignment.task_id, assignment.member_id);
    }
    return map;
  }, [dashboard?.assignments]);

  function setStatus(taskIds: string[], status: TaskStatus) {
    if (taskIds.length === 0) {
      return;
    }
    action.setStatus({
      task_ids: taskIds,
      status,
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 md:px-8 pb-10 pt-4">
      <div
        className={cn(
          "rounded-2xl border border-white/20 dark:border-white/10",
          "bg-[var(--card-bg)]/80 backdrop-blur-md",
          "px-5 py-5 md:px-7 md:py-6",
          "relative overflow-hidden",
        )}
      >
        <div className="absolute inset-0 -z-10 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.18),transparent_50%),radial-gradient(circle_at_top_left,rgba(59,130,246,0.16),transparent_45%)]" />
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] opacity-70">
              Template App
            </p>
            <h1 className="text-2xl md:text-3xl font-semibold mt-1">
              Team Ops Board
            </h1>
            <p className="opacity-75 mt-1 text-sm md:text-base">
              展示 CRUD、关系、事务、窗口命令与实时统计的一套完整模板。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 transition"
              onClick={action.bootstrap}
              disabled={loading}
            >
              Seed Demo
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm border border-zinc-500/40 bg-zinc-500/10 hover:bg-zinc-500/20 transition"
              onClick={action.loadSnapshot}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 transition"
              onClick={action.reset}
              disabled={loading}
            >
              Reset
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 transition"
              onClick={action.openWindow}
            >
              New Window
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 transition"
              onClick={action.captureMouse}
            >
              Capture Cursor
            </button>
          </div>
        </div>
      </div>

      {dashboard ? <StatsPanel stats={dashboard.stats} /> : null}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 mt-4">
        <section className="rounded-xl border border-white/20 dark:border-white/10 bg-[var(--card-bg)] p-4 space-y-5">
          <div>
            <h2 className="text-sm uppercase tracking-[0.14em] opacity-70 mb-2">
              Create Member
            </h2>
            <div className="space-y-2">
              <Input
                value={memberInput.id}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  action.setMemberId(value);
                }}
                placeholder="member id (e.g. mila)"
                className="w-full rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              />
              <Input
                value={memberInput.name}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  action.setMemberName(value);
                }}
                placeholder="name"
                className="w-full rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              />
              <Input
                value={memberInput.role}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  action.setMemberRole(value);
                }}
                placeholder="role"
                className="w-full rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              />
              <button
                type="button"
                className="w-full rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 hover:bg-cyan-500/20 transition"
                onClick={action.createMember}
                disabled={loading}
              >
                Save Member
              </button>
            </div>
          </div>

          <div>
            <h2 className="text-sm uppercase tracking-[0.14em] opacity-70 mb-2">
              Create Task
            </h2>
            <div className="space-y-2">
              <Input
                value={taskInput.id}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  action.setTaskId(value);
                }}
                placeholder="task id (e.g. billing-audit)"
                className="w-full rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              />
              <Input
                value={taskInput.title}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  action.setTaskTitle(value);
                }}
                placeholder="title"
                className="w-full rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              />
              <Input
                value={taskInput.notes}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  action.setTaskNotes(value);
                }}
                placeholder="notes"
                className="w-full rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={taskInput.status}
                  onChange={(event) => {
                    const value = event.currentTarget.value as TaskStatus;
                    action.setTaskStatus(value);
                  }}
                  className="app-select rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
                >
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {statusLabels[status]}
                    </option>
                  ))}
                </select>
                <Input
                  type="number"
                  min={1}
                  value={taskInput.priority}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    action.setTaskPriority(value);
                  }}
                  className="rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
                />
              </div>
              <button
                type="button"
                className="w-full rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 hover:bg-fuchsia-500/20 transition"
                onClick={action.createTask}
                disabled={loading}
              >
                Save Task
              </button>
            </div>
          </div>

          <div>
            <h2 className="text-sm uppercase tracking-[0.14em] opacity-70 mb-2">
              Bulk Status
            </h2>
            <div className="flex gap-2">
              <select
                value={bulkStatus}
                onChange={(event) =>
                  action.setBulkStatus(event.currentTarget.value as TaskStatus)
                }
                className="app-select flex-1 rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2"
              >
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-lg border border-lime-500/40 bg-lime-500/10 px-3 py-2 hover:bg-lime-500/20 transition"
                onClick={() => setStatus(selectedTaskIds, bulkStatus)}
                disabled={loading || selectedTaskIds.length === 0}
              >
                Apply
              </button>
            </div>
            <p className="text-xs opacity-70 mt-2">
              Selected tasks: {selectedTaskIds.length}
            </p>
          </div>

          {mouseInfo ? (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
              <p className="font-semibold mb-1">Mouse Debug</p>
              <p>
                cursor: ({mouseInfo.mouse_x}, {mouseInfo.mouse_y})
              </p>
              <p>
                window: ({mouseInfo.window_x}, {mouseInfo.window_y}) /{" "}
                {mouseInfo.window_width}x{mouseInfo.window_height}
              </p>
              <p>
                relative: ({mouseInfo.rel_x}, {mouseInfo.rel_y}) @{" "}
                {mouseInfo.pixel_ratio.toFixed(2)}
              </p>
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-white/20 dark:border-white/10 bg-[var(--card-bg)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm uppercase tracking-[0.14em] opacity-70">
              Task Board
            </h2>
            <p className="text-xs opacity-70">
              {loading ? "syncing..." : "ready"}
            </p>
          </div>

          <div className="space-y-3">
            {dashboard?.tasks.length ? (
              dashboard.tasks.map((task) => {
                const assignedMemberId =
                  assignmentMap.get(task.id) ?? task.owner_id ?? "";
                const selected = selectedTaskIds.includes(task.id);

                return (
                  <article
                    key={task.id}
                    className={cn(
                      "rounded-xl border p-3 md:p-4",
                      "border-white/20 dark:border-white/10",
                      selected && "ring-1 ring-cyan-500/50",
                    )}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => action.toggleTaskSelection(task.id)}
                          className="mt-1 size-4 accent-cyan-500"
                        />
                        <div>
                          <h3 className="text-base font-medium">
                            {task.title}
                          </h3>
                          <p className="text-xs opacity-70 font-mono mt-1">
                            {task.id}
                          </p>
                          <p className="text-sm opacity-80 mt-1">
                            {task.notes}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-xs",
                            statusStyles[task.status],
                          )}
                        >
                          {statusLabels[task.status]}
                        </span>
                        <span className="rounded-full border border-white/20 px-2.5 py-1 text-xs opacity-80">
                          P{task.priority}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2">
                      <select
                        value={assignedMemberId}
                        onChange={(event) => {
                          const memberId = event.currentTarget.value;
                          if (memberId) {
                            action.assignTask({
                              task_id: task.id,
                              member_id: memberId,
                            });
                          } else {
                            action.unassignTask({
                              task_id: task.id,
                            });
                          }
                        }}
                        className="app-select rounded-lg border border-white/20 dark:border-white/10 bg-transparent px-3 py-2 text-sm"
                      >
                        <option value="">Unassigned</option>
                        {dashboard.members.map((member) => (
                          <option key={member.id} value={member.id}>
                            {memberMap.get(member.id)}
                          </option>
                        ))}
                      </select>

                      {statusOptions.map((status) => (
                        <button
                          key={`${task.id}-${status}`}
                          type="button"
                          className={cn(
                            "rounded-lg border px-3 py-2 text-xs transition",
                            task.status === status
                              ? "border-cyan-500/40 bg-cyan-500/10"
                              : "border-white/20 dark:border-white/10 hover:bg-white/5",
                          )}
                          onClick={() => setStatus([task.id], status)}
                          disabled={loading}
                        >
                          {statusLabels[status]}
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="rounded-xl border border-dashed border-white/20 dark:border-white/10 p-8 text-center opacity-75">
                No tasks yet. Use “Seed Demo” or create one from the left panel.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Base({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen overflow-hidden hide-scrollbar">
      <TopBar />
      <main
        className={cn(
          "fixed top-0 left-0 h-screen w-full overflow-y-auto",
          "flex-1 flex flex-col hide-scrollbar",
        )}
      >
        <div className="min-h-8" />
        {children}
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}

function App() {
  const appWindow = useAppBootstrap();

  return me(appWindow.window).match({
    Main: () => (
      <Base>
        <TemplateBoard />
      </Base>
    ),
  });
}

export default App;
