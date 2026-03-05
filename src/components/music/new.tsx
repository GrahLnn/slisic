import { cn } from "@/lib/utils";
import { icons } from "@/src/assets/icons";
import { ListSeparator, EntryToolButton } from "@/src/components/uni";
import { Edit, ToolingBlocks, TrackEdit } from "./info";
import { action, hook } from "@/src/flow/music";

export function New() {
  const state = hook.useState();
  const ctx = hook.useContext();
  const isReview = hook.useIsReview();
  const slot = hook.useSlot();

  const duplicate = slot
    ? ctx.playlists
        .filter((playlist) => playlist.name !== ctx.selectedListName)
        .some(
          (playlist) =>
            playlist.name.toLowerCase() === slot.name.trim().toLowerCase(),
        )
    : true;

  const rs =
    slot &&
    !duplicate &&
    slot.name.trim().length > 0 &&
    slot.entries.length + slot.folders.length + slot.links.length > 0 &&
    !isReview
      ? "ok"
      : "err";

  return (
    <div className={cn(["mb-32 flex flex-col gap-4"])}>
      <div className="flex flex-col">
        <Edit
          title={state.match({
            create: () => "Create a New Playlist",
            edit: () => "Edit Playlist",
            _: () => "",
          })}
          explain={state.match({
            create: () =>
              "Add tracks and details to start building your playlist.",
            edit: () => "",
            _: () => "",
          })}
        />
        <ListSeparator />

        <ToolingBlocks />

        <ListSeparator />
        <TrackEdit />

        {ctx.ffmpeg ? (
          rs === "ok" ? (
            <>
              <div className="h-4" />
              <div className="flex items-center justify-center gap-4">
                <EntryToolButton
                  icon={<icons.check3 size={12} />}
                  label="Save"
                  onClick={() => {
                    if (isReview) return;
                    void action.save();
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="h-2" />
              <div className="w-full px-4 text-xs text-[#525252] dark:text-[#d4d4d4]">
                Notice: List Name are required and at least one item must be
                included..
              </div>
            </>
          )
        ) : (
          <>
            <div className="h-2" />
            <div className="w-full px-4 text-xs text-[#525252] dark:text-[#d4d4d4]">
              Notice: ffmpeg is required to support audio analysis.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
