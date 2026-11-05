// An inert reservation: it has no bindings, outbound calls, or scheduled handler.
export default {
  fetch() {
    return new Response("deployment_pending", {
      status: 503,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  },
};
