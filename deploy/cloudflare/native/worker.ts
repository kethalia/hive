import app from "../app/worker";
import auth from "../auth/worker";
import { createNativeWorker } from "./composition.mjs";

export default createNativeWorker({ app, auth });
