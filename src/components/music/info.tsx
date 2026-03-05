import { cn, host, isUrl, up1st } from "@/lib/utils";
import {
  DataList,
  EditHead,
  EntryToolButton,
  ListSeparator,
  Pair,
  PairCombobox,
  PairEdit,
  Head,
  MultiFolderChooser,
} from "@/src/components/uni";
import { icons, motionIcons } from "@/src/assets/icons";
import { action, hook } from "@/src/flow/music";
import { entryKey } from "@/src/flow/music/logic";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";

export function Edit({ title, explain }: { title: string; explain: string }) {
  const slot = hook.useSlot();
  const ctx = hook.useContext();
  if (!slot) return null;

  const check = ctx.playlists
    .map((item) => item.name)
    .filter((name) => name !== ctx.selectedListName);

  return (
    <DataList className="group rounded-lg border">
      <div className="flex flex-col gap-4 px-2">
        <EditHead title={title} explain={explain} />
        <PairEdit
          label="Name"
          explain="Give your playlist a name."
          value={slot.name}
          onChange={(value) => {
            const next = slot.name ? up1st(value) : value.trim();
            action.setSlot({ ...slot, name: next });
          }}
          check={check}
          warning="This list already exists"
        />
      </div>
    </DataList>
  );
}

function YtCheck() {
  const ctx = hook.useContext();
  return (
    <div className="my-2 ml-[14px] h-6 transition flex items-center gap-2 opacity-80">
      <div
        className={cn([
          "rounded-full border border-[#737373] dark:border-[#d4d4d4] text-[#262626] dark:text-[#e5e5e5]",
          ctx.ytdlp && "p-[2px]",
        ])}
      >
        {ctx.ytdlp ? <icons.check3 size={10} /> : <icons.plus size={12} />}
      </div>
      {ctx.ytdlp ? (
        <div
          className={cn([
            "text-xs text-[#404040] dark:text-[#e5e5e5] transition",
          ])}
        >
          yt-dlp {ctx.ytdlp.installed_version} is installed.
        </div>
      ) : (
        <div className="flex gap-2 items-center justify-between w-full pr-4">
          <div className="text-xs text-[#404040] dark:text-[#e5e5e5] transition">
            By use yt-dlp, you can download music from most sites.
          </div>
          <EntryToolButton
            label="Add yt-dlp"
            onClick={() => void action.installYtdlp()}
          />
        </div>
      )}
    </div>
  );
}

function FfmpegCheck() {
  const ctx = hook.useContext();
  return (
    <div className="my-2 ml-[14px] h-6 transition flex items-center gap-2 opacity-80">
      <div
        className={cn([
          "rounded-full border border-[#737373] dark:border-[#d4d4d4] text-[#262626] dark:text-[#e5e5e5]",
          ctx.ffmpeg && "p-[2px]",
        ])}
      >
        {ctx.ffmpeg ? <icons.check3 size={10} /> : <icons.plus size={12} />}
      </div>
      {ctx.ffmpeg ? (
        <div
          className={cn([
            "text-xs text-[#404040] dark:text-[#e5e5e5] transition",
          ])}
        >
          ffmpeg {ctx.ffmpeg.installed_version} is installed.
        </div>
      ) : (
        <div className="flex gap-2 items-center justify-between w-full pr-4">
          <div className="text-xs text-[#404040] dark:text-[#e5e5e5] transition">
            Using ffmpeg enables support for a wide range of audio
            post-processing capabilities.
          </div>
          <EntryToolButton
            label="Add ffmpeg"
            onClick={() => void action.installFfmpeg()}
          />
        </div>
      )}
    </div>
  );
}

function SaveCheck() {
  const ctx = hook.useContext();
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
          <span className="font-semibold">{ctx.savePath ?? "Unknown"}</span>
        </div>
        <EntryToolButton
          className="dark:text-[#e5e5e5]"
          label="Change"
          onClick={() => {
            open({ directory: true }).then((path) => {
              if (typeof path !== "string") return;
              void action.updateSavePath(path);
            });
          }}
        />
      </div>
    </div>
  );
}

function TrackPaster() {
  const slot = hook.useSlot();
  const allReview = hook.useAllReview();
  if (!slot) return null;

  const entriesUrl = slot.entries.map((entry) => entry.url);
  const entriesName = slot.entries.map((entry) => entry.name);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Head
          title="Web Link"
          explain="Copy the url and click paste button. Non-URL content will be discarded."
        />

        <EntryToolButton
          label="Paste"
          onClick={() => {
            readText().then((text) => {
              if (
                !text ||
                !isUrl(text) ||
                slot.links.some((item) => item.url === text)
              ) {
                return;
              }

              if (entriesUrl.some((url) => url === text)) {
                action.setSlot({
                  ...slot,
                  links: [
                    ...slot.links,
                    {
                      url: text,
                      title_or_msg: "",
                      status: null,
                      count: null,
                      entry_type:
                        slot.entries.find((entry) => entry.url === text)
                          ?.entry_type ?? "Unknown",
                      tracking: false,
                    },
                  ],
                });
                return;
              }

              void action.addLink(text);
            });
          }}
        />
      </div>

      {[...slot.links].reverse().map((link) => {
        const verified =
          !entriesUrl.includes(link.url) &&
          !entriesName.includes(link.title_or_msg);

        return (
          <Pair
            key={link.url}
            label={
              host(link.url) +
              (link.entry_type ? `·${link.entry_type}` : "") +
              (link.count != null ? ` (${link.count} items)` : "") +
              (link.tracking ? "·tracking" : "")
            }
            value={`${link.title_or_msg}${verified ? "" : "[Already exists]"}`}
            bantoggle
            on
            banTip="Remove"
            banfn={() => {
              action.removeLink(link.url);
            }}
            verified={
              link.status
                ? link.status === "Ok" && verified
                : allReview.includes(link.url) || verified
            }
            anime={link.status === null}
          />
        );
      })}
    </div>
  );
}

function Entries() {
  const slot = hook.useSlot();
  const list = hook.useList();
  const inProgressFolder = hook.useAllFolderReview();
  const inProgressWeblist = hook.useAllWeblistReview();
  if (!slot) return null;

  const existingKeys = new Set(slot.entries.map((item) => entryKey(item)));
  const allEntry = list.flatMap((playlist) =>
    playlist.entries.filter((entry) => !existingKeys.has(entryKey(entry))),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Head
          title="Entries"
          explain="Manage your selected entries, or bring in more from other playlists."
        />
        <PairCombobox
          label="Add Existing"
          list={[...allEntry].map((entry) => entry.name)}
          width="480px"
          onChoose={(name) => {
            const found = allEntry.find((entry) => entry.name === name);
            if (!found) return;
            action.addExistingEntry(found);
          }}
        />
      </div>

      {slot.entries.length > 0 ? (
        slot.entries.map((entry) => (
          <div
            key={entry.path ?? entry.url ?? entry.name}
            className="flex flex-col gap-1"
          >
            <Pair
              label={entry.name}
              value={`${entry.entry_type}·${entry.musics.length}${entry.musics.length > 1 ? " items" : " item"}`}
              bantoggle
              on
              banTip="Remove"
              banfn={() => action.removeEntry(entry)}
              rightButton={
                entry.entry_type === "WebList"
                  ? [
                      {
                        name: "Update",
                        onClick: () => void action.updateWeblist(entry),
                        inProgress:
                          !!entry.url && inProgressWeblist.includes(entry.url),
                      },
                      {
                        name: "Reload",
                        onClick: () => void action.reloadEntry(entry),
                        inProgress:
                          !!entry.path && inProgressFolder.includes(entry.path),
                      },
                    ]
                  : [
                      {
                        name: "Reload",
                        onClick: () => void action.reloadEntry(entry),
                        inProgress:
                          !!entry.path && inProgressFolder.includes(entry.path),
                      },
                    ]
              }
            />
          </div>
        ))
      ) : (
        <div className="text-xs text-[#525252] transition dark:text-[#a3a3a3]">
          No entries
        </div>
      )}
    </div>
  );
}

function Exclude() {
  const slot = hook.useSlot();
  if (!slot) return null;

  return (
    <div className="flex flex-col gap-2">
      <Head title="Exclude" />
      {slot.exclude.length > 0 ? (
        slot.exclude.map((music) => (
          <div key={music.path} className="flex flex-col gap-1">
            <Pair
              label={music.title}
              value=""
              allowEmptyValue
              bantoggle
              on
              banTip="Remove"
              banfn={() => action.removeExclude(music.path)}
            />
          </div>
        ))
      ) : (
        <div className="text-xs text-[#525252] transition dark:text-[#a3a3a3]">
          No Exclude
        </div>
      )}
    </div>
  );
}

export function TrackEdit() {
  const slot = hook.useSlot();
  const mainState = hook.useState();
  const ctx = hook.useContext();
  if (!slot) return null;

  return (
    <DataList className="group rounded-lg border">
      <div className="flex flex-col gap-4 px-2">
        <EditHead title="Tracks" explain="Add tracks to your playlist." />
        <div />

        <MultiFolderChooser
          value={slot.folders.map((folder) => ({
            k: folder.path,
            v: `${folder.items.length}${folder.items.length === 1 ? " item" : " items"}`,
          }))}
          enabled={!!ctx.ffmpeg}
          onChoose={(path) => {
            if (!path || slot.folders.some((folder) => folder.path === path))
              return;
            void action.addFolder(path);
          }}
          ondelete={(path) => action.removeFolder(path)}
          check={slot.entries
            .map((entry) => entry.path)
            .filter((path): path is string => !!path)}
        />

        {ctx.ytdlp ? (
          <TrackPaster />
        ) : (
          <Head
            title="Web Link"
            explain="yt-dlp is required to download online media."
          />
        )}

        {mainState.match({
          create: () => <Entries />,
          edit: () => <Entries />,
          _: () => null,
        })}

        {mainState.match({
          edit: () => <Exclude />,
          _: () => null,
        })}
      </div>
    </DataList>
  );
}

export function ToolingBlocks() {
  return (
    <>
      <YtCheck />
      <ListSeparator />
      <FfmpegCheck />
      <ListSeparator />
      <SaveCheck />
    </>
  );
}
