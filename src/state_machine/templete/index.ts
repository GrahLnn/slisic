import { actor } from "./api";

actor.start();
actor.subscribe((snapshot) => {
  const state =
    typeof snapshot.value === "string"
      ? snapshot.value
      : JSON.stringify(snapshot.value);

  console.log(`[templete] ${state}`, snapshot.context);
});
export * from "./api";
export * from "./events";
