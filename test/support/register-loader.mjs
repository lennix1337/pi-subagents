
import * as nodeModule from "node:module";
import "./isolated-temp-root.mjs";
import { resolve } from "./ts-loader.mjs";

if (nodeModule.registerHooks) nodeModule.registerHooks({ resolve });
else nodeModule.register(new URL("./ts-loader.mjs", import.meta.url));
