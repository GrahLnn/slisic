import { actor } from "./api";

actor.start();
actor.subscribe((snapshot) => {
  const state =
    typeof snapshot.value === "string"
      ? snapshot.value
      : JSON.stringify(snapshot.value);

  console.log(state, snapshot.context);
});
export * from "./api";
export * from "./state";
export { actor } from "./api";
