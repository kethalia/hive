import app from "../app/worker";
import auth from "../auth/worker";
import jobs from "../jobs/worker";
import { createNativeWorker } from "./composition.mjs";

export default createNativeWorker({ app, auth, jobs });
