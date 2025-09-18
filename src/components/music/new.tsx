import { icons, motionIcons } from "@/src/assets/icons";
import { EntryToolButton, ListSeparator, Pair } from "../uni";
import { cn } from "@/lib/utils";
import { me } from "@/lib/matchable";
import { action, hook, ResultStateT } from "@/src/state_machine/music";
import {
  hook as globalHook,
  action as globalAction,
} from "@/src/state_machine/global";
import { hook as ythook, action as ytaction } from "@/src/state_machine/ytdlp";
import { hook as ffhook, action as ffaction } from "@/src/state_machine/ffmpeg";
import { Edit, TrackEdit } from "./info";
import { open } from "@tauri-apps/plugin-dialog";
import { K } from "@/lib/comb";

function YtCheck() {
  const ytdlp = ythook.useState();
  const ytctx = ythook.useContext();
  return (
    <div className="my-2 ml-[14px] h-6 transition flex items-center gap-2 opacity-80">
      <div
        className={cn([
          "rounded-full border border-[#737373] dark:border-[#d4d4d4] text-[#262626] dark:text-[#e5e5e5]",
          ytdlp.is("exist") && "p-[2px]",
        ])}
      >
        {ytdlp.match({
          exist: () => <icons.check3 size={10} />,
          not_exist: () => <icons.plus size={12} />,
          _: () => (
            <div className="text-[#dbab0a]">
              <motionIcons.live
                size={12}
                className="animate-spin [animation-duration:5s]"
              />
            </div>
          ),
        })}
      </div>
      {ytdlp.match({
        exist: () => (
          <div
            className={cn([
              "text-xs text-[#404040] dark:text-[#e5e5e5] transition",
            ])}
          >
            yt-dlp {ytctx.version} is installed.
          </div>
        ),
        not_exist: () => (
          <div className="flex gap-2 items-center justify-between w-full pr-4">
            <div className="text-xs text-[#404040] dark:text-[#e5e5e5] transition">
              By use yt-dlp, you can download music from most sites.
            </div>
            <EntryToolButton
              label="Add yt-dlp"
              onClick={ytaction.download_ytdlp}
            />
          </div>
        ),
        _: () => (
          <div
            className={cn([
              "text-xs text-[#404040] dark:text-[#e5e5e5] transition",
            ])}
          >
            downloading...
          </div>
        ),
      })}
    </div>
  );
}

function FfmpegCheck() {
  const ytdlp = ffhook.useState();
  const ytctx = ffhook.useContext();
  return (
    <div className="my-2 ml-[14px] h-6 transition flex items-center gap-2 opacity-80">
      <div
        className={cn([
          "rounded-full border border-[#737373] dark:border-[#d4d4d4] text-[#262626] dark:text-[#e5e5e5]",
          ytdlp.is("exist") && "p-[2px]",
        ])}
      >
        {ytdlp.match({
          exist: () => <icons.check3 size={10} />,
          not_exist: () => <icons.plus size={12} />,
          _: () => (
            <div className="text-[#dbab0a] dark:text-[#ffc402]">
              <motionIcons.live
                size={12}
                className="animate-spin [animation-duration:5s]"
              />
            </div>
          ),
        })}
      </div>
      {ytdlp.match({
        exist: () => (
          <div
            className={cn([
              "text-xs text-[#404040] dark:text-[#e5e5e5] transition",
            ])}
          >
            ffmpeg {ytctx.version} is installed.
          </div>
        ),
        not_exist: () => (
          <div className="flex gap-2 items-center justify-between w-full pr-4">
            <div className="text-xs text-[#404040] dark:text-[#e5e5e5] transition">
              Using ffmpeg enables support for a wide range of audio
              post-processing capabilities.
            </div>
            <EntryToolButton
              label="Add ffmpeg"
              onClick={ffaction.download_ffmpeg}
            />
          </div>
        ),
        _: () => (
          <div
            className={cn([
              "text-xs text-[#404040] dark:text-[#e5e5e5] transition",
            ])}
          >
            downloading...
          </div>
        ),
      })}
    </div>
  );
}

function SaveCheck() {
  const ctx = globalHook.useContext();
  return (
    <div className="my-2 ml-[12px] h-6 transition flex items-center gap-2 opacity-80">
      <div
        className={cn([
          "rounded-full border border-[#737373] dark:border-[#d4d4d4] text-[#262626] dark:text-[#e5e5e5]",
          "p-[2px]",
        ])}
      >
        <motionIcons.cloudDownload size={12} />
      </div>
      <div className="flex gap-2 items-center justify-between w-full pr-4">
        <div className="text-xs text-[#404040] dark:text-[#e5e5e5] transition">
          Web music will be saved to{" "}
          <span className="font-semibold">{ctx.default_save_path}</span>
        </div>
        <EntryToolButton
          className="dark:text-[#e5e5e5]"
          label="Change"
          onClick={() =>
            open({ directory: true }).then((path) => {
              if (!path) return;
              globalAction.update_save_path(path);
            })
          }
        />
      </div>
    </div>
  );
}

export function New() {
  const state = hook.useState();

  return (
    <div className={cn(["flex flex-col gap-4 mb-32"])}>
      <div className="flex flex-col">
        <Edit
          title={state.match({
            create: K("Create a New Playlist"),
            edit: K("Edit Playlist"),
            saving: K("Saving Playlist"),
            _: K(""),
          })}
          explain={state.match({
            create: K(
              "Add tracks and details to start building your playlist."
            ),
            edit: K(""),
            _: K(""),
          })}
        />
        <ListSeparator />
        <YtCheck />
        <ListSeparator />
        <FfmpegCheck />
        <ListSeparator />
        <SaveCheck />
        <ListSeparator />
        <TrackEdit />
        {state.catch(
          "create",
          "edit"
        )((r: ResultStateT) =>
          me(r).match({
            ok: () => (
              <>
                <div className="h-4" />
                <div className="flex gap-4 items-center justify-center">
                  <EntryToolButton
                    icon={<icons.check3 size={12} />}
                    label="Save"
                    onClick={action.save}
                  />
                </div>
              </>
            ),
            err: () => (
              <>
                <div className="h-2" />
                <div className="text-xs text-[#525252] dark:text-[#d4d4d4] w-full px-4">
                  Notice: List Name are required and at least one item must be
                  included..
                </div>
              </>
            ),
          })
        )}
      </div>
    </div>
  );
}
