import { useHomeState } from "../state_machine/home";
import Home from "./home";
import { Provider } from "jotai";
import { appStore } from "../subpub/core";

export default function Pages() {
  const state = useHomeState();

  return state.match({
    home: () => <Home />,
  });
}
