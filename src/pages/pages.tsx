import { useHomeState } from "../state_machine/home";
import Home from "./home";

export default function Pages() {
  const state = useHomeState();

  return state.match({
    home: () => <Home />,
  });
}
