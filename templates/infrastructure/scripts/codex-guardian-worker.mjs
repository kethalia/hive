// Installed, inherited-FD protocol only. Never a network listener or model API.
import { Socket } from "node:net";

const check = (value) => {
  if (!value) throw new Error("guardian_worker_protocol_rejected");
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export function guardianBinding(value) {
  check(
    value &&
      uuid.test(value.lifetimeId) &&
      digest.test(value.bindingDigest) &&
      digest.test(value.ownershipDigest) &&
      Number.isSafeInteger(value.generation) &&
      value.generation > 0,
  );
  return value;
}
export function guardianProject(value) {
  check(
    value &&
      Object.keys(value).sort().join() === "bindingDigest,projectId" &&
      uuid.test(value.projectId) &&
      digest.test(value.bindingDigest),
  );
  return { projectId: value.projectId, bindingDigest: value.bindingDigest };
}

// Each endpoint has independent monotonically increasing IDs. Worker input and
// output never share the guardian's C control stream. No replay mutates state.
export function guardianWire(stream, handlers, onLost) {
  let active = 0;
  let sequence = 0,
    received = 0,
    buffer = Buffer.alloc(0),
    closed = false;
  const pending = new Map();
  const stop = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("guardian_worker_channel_lost"));
    }
    pending.clear();
    onLost();
  };
  const send = (value) => {
    check(!closed);
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
    check(encoded.length <= 32768 && stream.writableLength + encoded.length <= 65536);
    stream.write(encoded);
  };
  stream.on("error", stop);
  stream.on("end", stop);
  stream.on("close", stop);
  stream.on("data", (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      check(buffer.length <= 65536);
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) {
          check(buffer.length <= 32768);
          break;
        }
        check(end > 0 && end <= 32768);
        const value = JSON.parse(buffer.subarray(0, end));
        buffer = buffer.subarray(end + 1);
        check(
          value && value.protocolVersion === 1 && Number.isSafeInteger(value.id) && value.id > 0,
        );
        if (value.type === "response") {
          check(
            Object.keys(value).sort().join() === "id,ok,protocolVersion,type,value" &&
              typeof value.ok === "boolean",
          );
          const item = pending.get(value.id);
          check(item);
          pending.delete(value.id);
          clearTimeout(item.timer);
          if (value.ok) item.resolve(value.value);
          else item.reject(new Error("guardian_worker_request_rejected"));
        } else {
          check(
            value.type === "request" &&
              Object.keys(value).sort().join() === "id,method,protocolVersion,type,value" &&
              value.id === received + 1 &&
              Object.hasOwn(handlers, value.method),
          );
          received = value.id;
          check(++active <= 32);
          Promise.resolve()
            .then(() => handlers[value.method](value.value))
            .then(
              (result) => {
                if (!closed)
                  send({
                    protocolVersion: 1,
                    type: "response",
                    id: value.id,
                    ok: true,
                    value: result,
                  });
              },
              () => {
                if (!closed)
                  send({
                    protocolVersion: 1,
                    type: "response",
                    id: value.id,
                    ok: false,
                    value: null,
                  });
              },
            )
            .catch(stop)
            .finally(() => {
              active--;
            });
        }
      }
    } catch {
      stop();
    }
  });
  return {
    request(method, value, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        try {
          check(!closed && pending.size < 32 && timeoutMs > 0 && timeoutMs <= 10000);
          const id = ++sequence;
          const timer = setTimeout(stop, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          send({ protocolVersion: 1, type: "request", id, method, value });
        } catch (error) {
          reject(error);
          stop();
        }
      });
    },
    close: stop,
  };
}

export async function connectGuardianWorker({ fd = 3, onCloseAdmission, onLost }) {
  check(fd === 3 && typeof onCloseAdmission === "function" && typeof onLost === "function");
  let phase = "starting",
    binding,
    wire;
  const projects = new Map();
  const lost = () => {
    if (phase !== "closed") phase = "indeterminate";
    onLost();
  };
  wire = guardianWire(
    new Socket({ fd, readable: true, writable: true }),
    {
      async closeAdmission(value) {
        guardianBinding(value);
        check(
          phase === "open" &&
            value.lifetimeId === binding.lifetimeId &&
            value.bindingDigest === binding.bindingDigest &&
            value.generation >= binding.generation &&
            uuid.test(value.barrierId) &&
            Array.isArray(value.projects) &&
            value.projects.length === projects.size &&
            new Set(value.projects.map((project) => project.projectId)).size === projects.size &&
            value.projects.every((project) => {
              guardianProject(project);
              return projects.get(project.projectId)?.bindingDigest === project.bindingDigest;
            }),
        );
        // Synchronous fence comes BEFORE the durable inner barrier callback.
        phase = "closed";
        await onCloseAdmission(structuredClone(value));
        return {
          lifetimeId: value.lifetimeId,
          generation: value.generation,
          ownershipDigest: value.ownershipDigest,
          barrierId: value.barrierId,
          closed: true,
        };
      },
    },
    lost,
  );
  try {
    binding = guardianBinding(await wire.request("hello", { pid: process.pid }));
    phase = "open";
  } catch (error) {
    wire.close();
    throw error;
  }
  const token = (project) =>
    Object.freeze({
      projectId: project.projectId,
      projectBindingDigest: project.bindingDigest,
      ...binding,
    });
  const assertAdmission = (value) => {
    check(
      phase === "open" &&
        value?.lifetimeId === binding.lifetimeId &&
        value.bindingDigest === binding.bindingDigest &&
        value.projectBindingDigest === projects.get(value.projectId)?.bindingDigest &&
        value.generation === binding.generation &&
        value.ownershipDigest === binding.ownershipDigest,
    );
  };
  return {
    get state() {
      return structuredClone({ phase, ...binding, projects: [...projects.values()] });
    },
    async admit(value) {
      const project = guardianProject(value);
      check(phase === "open");
      const answer = guardianBinding(await wire.request("admit", project));
      check(
        phase === "open" &&
          answer.lifetimeId === binding.lifetimeId &&
          answer.bindingDigest === binding.bindingDigest &&
          answer.generation >= binding.generation,
      );
      binding = answer;
      projects.set(project.projectId, project);
      return token(project);
    },
    async executionFence(value) {
      check(
        phase === "open" &&
          value?.lifetimeId === binding.lifetimeId &&
          value.bindingDigest === binding.bindingDigest &&
          projects.get(value.projectId)?.bindingDigest === value.projectBindingDigest,
      );
      const answer = guardianBinding(
        await wire.request("fence", {
          projectId: value.projectId,
          bindingDigest: value.projectBindingDigest,
        }),
      );
      check(
        phase === "open" &&
          answer.lifetimeId === binding.lifetimeId &&
          answer.bindingDigest === binding.bindingDigest &&
          answer.generation >= binding.generation,
      );
      binding = answer;
      return token(projects.get(value.projectId));
    },
    assertAdmission,
    close: () => wire.close(),
  };
}
