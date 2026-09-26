interface PublishEnvironment {
  GITHUB_DISPATCH_TOKEN?: string;
  NOTION_WEBHOOK_SECRET?: string;
}

declare const worker: {
  fetch(request: Request, env: PublishEnvironment): Promise<Response>;
};

export default worker;
