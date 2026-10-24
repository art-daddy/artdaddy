import { __setExportConfirmationForTests } from "../lib/confirm";
import { installNetworkGuard } from "./networkGuard";

installNetworkGuard();
__setExportConfirmationForTests(async () => "continue");
