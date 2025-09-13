import { cn, host, inside, isUrl, up1st } from "@/lib/utils";
import {
  DataList,
  EditHead,
  EntryToolButton,
  Head,
  MultiFolderChooser,
  Pair,
  PairEdit,
} from "../uni";
import { hook, action } from "@/src/state_machine/music";
import { hook as ythook } from "@/src/state_machine/ytdlp";
import crab from "@/src/cmd";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { K } from "@/lib/comb";
import { me } from "@/lib/matchable";
import { udf } from "@/lib/e";

export function Edit({ title, explain }: { title: string; explain: string }) {
  const slot = hook.useSlot();
  const ctx = hook.useContext();
  const lists = ctx.collections;
  const selected = ctx.selected;
  if (!slot) return;
  return (
    <DataList className={cn(["group", "border rounded-lg"])}>
      <div className="flex flex-col gap-4 px-2">
        <EditHead title={title} explain={explain} />
        <PairEdit
          label="Name"
          explain="Give your playlist a name."
          value={slot.name}
          onChange={(val) => {
            if (!slot) return;
            const name = slot.name ? up1st(val) : val.trim();
            action.set_slot({
              ...slot,
              name,
            });
          }}
          check={lists.map((l) => l.name).filter((n) => n !== selected?.name)}
          warning="This list already exists"
        />
      </div>
    </DataList>
  );
}

function TrackPaster() {
  const slot = hook.useSlot();
  const isreview = hook.useIsReview();
  if (!slot) return;
  const entriesurl = slot.entries.map((e) => e.url);
  const entriesname = slot.entries.map((e) => e.name);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <Head
          title="Web Link"
          explain="Copy the url and click paste button. Non-URL content will be
            discarded."
        />

        <EntryToolButton
          label="Paste"
          onClick={() => {
            readText().then((r) => {
              if (!r || !isUrl(r)) return;
              if (entriesurl.some((e) => e === r)) {
                action.set_slot({
                  ...slot,
                  links: [
                    ...slot.links,
                    {
                      url: r,
                      title_or_msg: "",
                      status: null,
                      count: null,
                      entry_type: "Unknown",
                      tracking: false,
                    },
                  ],
                });
                return;
              }
              action.set_slot({
                ...slot,
                links: [
                  ...slot.links,
                  {
                    url: r,
                    title_or_msg: `Detecting[${inside(r)}]`,
                    status: null,
                    count: null,
                    entry_type: "Unknown",
                    tracking: false,
                  },
                ],
              });
              action.add_review(r);
            });
          }}
        />
      </div>
      {slot.links.map((v) => {
        const verified =
          !entriesurl.includes(v.url) && !entriesname.includes(v.title_or_msg);
        return (
          <Pair
            key={v.url}
            label={
              host(v.url) +
              (v.entry_type ? `·${v.entry_type}` : "") +
              (v.count != null ? ` (${v.count} items)` : "") +
              (v.tracking ? "·tracking" : "")
            }
            value={v.title_or_msg + (!verified ? "[Already exists]" : "")}
            bantoggle
            on
            banTip="Remove"
            banfn={() => {
              action.set_slot({
                ...slot,
                links: slot.links.filter((f) => f.url !== v.url),
              });
              action.cancle_review(v.url);
            }}
            verified={
              v.status
                ? me(v.status).match({
                    Ok: K(verified),
                    Err: K(false),
                  })
                : isreview || verified
            }
            anime={v.status === null}
            rightButton={
              v.entry_type === "WebList"
                ? [
                    {
                      name: v.tracking
                        ? "Disable Playlist Tracking"
                        : "Enable Playlist Tracking",
                      onClick: () =>
                        action.set_slot({
                          ...slot,
                          links: slot.links.map((l) =>
                            l.url === v.url
                              ? { ...l, tracking: !l.tracking }
                              : l
                          ),
                        }),
                    },
                  ]
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

function Entries() {
  const slot = hook.useSlot();
  const inProgressFolder = hook.useAllFolderReview();
  if (!slot) return;
  return (
    <div className="flex flex-col gap-2">
      <Head title="Entries" />
      {slot.entries.length > 0 ? (
        slot.entries.map((v) => (
          <div key={v.path} className="flex flex-col gap-1">
            <Pair
              label={v.name}
              value={`${v.entry_type}·${v.musics.length.toString()}${
                v.musics.length > 1 ? " items" : " item"
              }`}
              bantoggle
              on
              banTip="Remove"
              banfn={() => {
                action.set_slot({
                  ...slot,
                  entries: slot.entries.filter((f) => f.path !== v.path),
                });
              }}
              rightButton={me(v.entry_type).match({
                WebList: K([
                  { name: "Update" },
                  {
                    name: "Reload",
                    onClick: () => action.add_folder_check(v),
                    inProgress: inProgressFolder.includes(v.path!),
                  },
                ]),
                _: K([
                  {
                    name: "Reload",
                    onClick: () => action.add_folder_check(v),
                    inProgress: inProgressFolder.includes(v.path!),
                  },
                ]),
              })}
            />
          </div>
        ))
      ) : (
        <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
          No entries
        </div>
      )}
    </div>
  );
}

function Exclude() {
  const slot = hook.useSlot();
  if (!slot) return;
  return (
    <div className="flex flex-col gap-2">
      <Head title="Entries" />
      {slot.exclude.length > 0 ? (
        slot.exclude.map((v) => (
          <div key={v.path} className="flex flex-col gap-1">
            <Pair
              label={v.title}
              value=""
              allowEmptyValue
              bantoggle
              on
              banTip="Remove"
              banfn={() => {
                action.set_slot({
                  ...slot,
                  exclude: slot.exclude.filter((f) => f.path !== v.path),
                });
              }}
            />
          </div>
        ))
      ) : (
        <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
          No Exclude
        </div>
      )}
    </div>
  );
}

export function TrackEdit() {
  const slot = hook.useSlot();
  const mainstate = hook.useState();
  const ytstate = ythook.useState();
  if (!slot) return;
  return (
    <DataList className={cn(["group", "border rounded-lg"])}>
      <div className="flex flex-col gap-4 px-2">
        <EditHead title="Tracks" explain="Add tracks to your playlist." />
        <div />
        <MultiFolderChooser
          label="Local Folder"
          explain="Select the folder that contains your music files."
          value={slot.folders.map((f) => ({
            k: f.path,
            v:
              f.items.length.toString() +
              (f.items.length === 1 ? " item" : " items"),
          }))}
          onChoose={(path) => {
            if (!slot || !path) return;
            crab.allAudioRecursive(path).then((r) =>
              r.tap((items) => {
                if (slot.folders.map((f) => f.path).includes(path)) return;
                action.set_slot({
                  ...slot,
                  folders: [
                    ...slot.folders,
                    {
                      path,
                      items,
                    },
                  ],
                });
              })
            );
          }}
          ondelete={(path) => {
            if (!slot || !path) return;
            action.set_slot({
              ...slot,
              folders: slot.folders.filter((f) => f.path !== path),
            });
          }}
          check={
            slot.entries
              .map((e) => e.path)
              .filter((p): p is string => p !== null) ?? []
          }
        />
        {ytstate.match({
          exist: () => <TrackPaster />,
          _: () => (
            <Head title="Web Link" explain="Add web links to your playlist." />
          ),
        })}
        {mainstate.catch("edit")(() => (
          <>
            <Entries />
            <Exclude />
          </>
        ))}
      </div>
    </DataList>
  );
}
