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

export function Edit({ title, explain }: { title: string; explain: string }) {
  const slot = hook.useSlot();
  const ctx = hook.useContext();
  const lists = ctx.collections;
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
          check={lists.map((l) => l.name)}
          warning="This list already exists"
        />
      </div>
    </DataList>
  );
}

function TrackPaster() {
  const slot = hook.useSlot();
  if (!slot) return;
  const value = slot.links.map((v) => ({
    k: v.url,
    v: v.title_or_msg,
    s: v.status,
  }));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-semibold text-[#262626] dark:text-[#d4d4d4] transition">
            Web Link
          </div>
          <div
            className={cn([
              "text-xs transition",
              "text-[#525252] dark:text-[#a3a3a3]",
            ])}
          >
            Copy the url and click paste button. Non-URL content will be
            discarded.
          </div>
        </div>
        <EntryToolButton
          label="Paste"
          onClick={() => {
            readText().then((r) => {
              if (!r || !isUrl(r)) return;
              action.set_slot({
                ...slot,
                links: [
                  ...slot.links,
                  {
                    url: r,
                    title_or_msg: inside(r),
                    status: null,
                    tracking: false,
                  },
                ],
              });
              action.add_review(r);
            });
          }}
        />
      </div>
      {value.map((v) => (
        <Pair
          key={v.k}
          label={host(v.k)}
          value={v.v}
          bantoggle
          on
          banTip="Remove"
          banfn={() => {
            action.set_slot({
              ...slot,
              links: slot.links.filter((f) => f.url !== v.k),
            });
          }}
          verified={
            v.s
              ? me(v.s).match({
                  Ok: K(true),
                  Err: K(false),
                })
              : true
          }
          anime={v.s === null}
        />
      ))}
    </div>
  );
}

export function TrackEdit() {
  const slot = hook.useSlot();
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
        />
        {ytstate.match({
          exist: () => <TrackPaster />,
          _: () => (
            <div className="flex flex-col gap-1">
              <div className="text-sm font-semibold text-[#525252] dark:text-[#a3a3a3] transition">
                Web Link
              </div>
              <div
                className={cn([
                  "text-xs transition",
                  "text-[#525252] dark:text-[#a3a3a3]",
                ])}
              >
                yt-dlp not installed, can not use download feature.
              </div>
            </div>
          ),
        })}
      </div>
    </DataList>
  );
}
