const healthService = {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }

    return Response.json({ service: "health-service", status: "ok" });
  },
} satisfies ExportedHandler;

export default healthService;
