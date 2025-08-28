import crab from "@/src/cmd";
import { ActorInput, createActors } from "../kit";

export const utils = {
  async update_save_path({ input }: ActorInput<{ new_path: string }>) {
    const a = await crab.updateSavePath(input.new_path);
    a.unwrap();
  },
  async resolve_save_path() {
    const a = await crab.resolveSavePath();
    return a.unwrap();
  },
};

export const invoker = createActors(utils);
