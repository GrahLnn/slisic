import {
  cn,
  formatUrl,
  host,
  inside,
  isUrl,
  up1st,
  urlRegex,
} from "@/lib/utils";
import {
  DataList,
  EditHead,
  EntryToolButton,
  EntryToolButtonSwitch,
  Head,
  MultiFolderChooser,
  Pair,
  PairChoose,
  PairEdit,
} from "../uni";
import { icons, motionIcons } from "@/src/assets/icons";
import { motion } from "motion/react";
import { hook, action } from "@/src/state_machine/music";
import { hook as ythook, action as ytaction } from "@/src/state_machine/ytdlp";
import crab from "@/src/cmd";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { K } from "@/lib/comb";
import { me } from "@/lib/matchable";
import { LinkSample } from "@/src/cmd/commands";
import { useEffect } from "react";

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
                      entry_type: "",
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
                    entry_type: "",
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
              (v.count != null ? ` (${v.count} items)` : "")
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
          />
        );
      })}
    </div>
  );
}

function Entries() {
  const slot = hook.useSlot();
  if (!slot) return;
  return (
    <div className="flex flex-col gap-2">
      <Head title="Entries" />
      {slot.entries.length > 0 ? (
        slot.entries.map((v) => (
          <Pair
            key={v.path}
            label={v.path}
            value={
              v.musics.length.toString() +
              (v.musics.length > 1 ? " items" : " item")
            }
            bantoggle
            on
            banTip="Remove"
            banfn={() => {
              action.set_slot({
                ...slot,
                entries: slot.entries.filter((f) => f.path !== v.path),
              });
            }}
          />
        ))
      ) : (
        <div className="text-xs text-[#525252] dark:text-[#a3a3a3] transition">
          No entries
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
          <Entries />
        ))}
      </div>
    </DataList>
  );
}
