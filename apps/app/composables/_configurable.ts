import { isClient } from "~/utils";

export interface ConfigurableNavigator {
  /*
   * Specify a custom `navigator` instance, e.g. working with iframes or in testing environments.
   */
  navigator?: Navigator
}

export const defaultNavigator = /* #__PURE__ */ isClient ? window.navigator : undefined
