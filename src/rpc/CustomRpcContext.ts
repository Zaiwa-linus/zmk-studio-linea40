import { createContext } from "react";
import type { CustomRpcChannel } from "./customRpcChannel";

export const CustomRpcContext = createContext<CustomRpcChannel | null>(null);
