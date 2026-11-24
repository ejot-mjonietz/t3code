import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadDescendantPullRequest } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { ComposerControl } from "./chat/ComposerControl";
import {
  ThreadPullRequestBadgeControl,
  ThreadRowLeadingStatus,
  useThreadDisplayedPullRequest,
} from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("environment-test");
// Kept alive so a value set before render survives until the badge reads it.
const descendantsAtom = Atom.make<ReadonlyArray<ThreadDescendantPullRequest>>([]).pipe(
  Atom.keepAlive,
);

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => null,
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { threadPullRequests: true } } }],
    ])) as never,
}));
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      descendantPullRequestsAtom: (() => descendantsAtom) as never,
    },
  };
});

const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "example/repo",
  number: 7,
  url: "https://github.com/example/repo/pull/7",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00Z",
  stack: null,
  snapshot: {
    state: "merged",
    title: "Linked change",
    headBranch: "deleted-branch",
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-01-03T00:00:00Z",
  },
};

// The chat's pull request badge, wired as the branch toolbar wires it.
function ChatPullRequestBadge({ thread }: { thread: Thread }) {
  const displayed = useThreadDisplayedPullRequest(
    scopeThreadRef(thread.environmentId, thread.id),
    thread,
  );
  return (
    <ThreadPullRequestBadgeControl
      render={<ComposerControl size="xs" />}
      badge={displayed.badge}
      pullRequests={displayed.pullRequests}
      descendants={displayed.descendants}
      number={displayed.number}
      url={displayed.url}
      status={displayed.status}
      onOpenList={() => {}}
      onOpenPullRequest={(event) => event.preventDefault()}
    />
  );
}

it("updates palette PR status from linked snapshots without a legacy link or branch PR", async () => {
  const row = (pullRequest: ThreadPullRequestLink) => (
    <AppAtomRegistryProvider>
      <ThreadRowLeadingStatus
        thread={makeThreadFixture({
          environmentId,
          linkedPullRequest: null,
          branchPullRequest: null,
          pullRequests: [pullRequest],
        })}
      />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(row(link));
  await expect.element(screen.getByLabelText("PR #7 - Merged: Linked change")).toBeVisible();
  await expect.element(screen.getByLabelText("PR #7, status pending")).not.toBeInTheDocument();

  await screen.rerender(row({ ...link, snapshot: null }));
  await expect.element(screen.getByLabelText("PR #7, status pending")).toBeVisible();
  await expect
    .element(screen.getByLabelText("PR #7 - Merged: Linked change"))
    .not.toBeInTheDocument();

  await screen.rerender(
    row({ ...link, snapshot: { ...link.snapshot!, state: "open", isDraft: true } }),
  );
  await expect.element(screen.getByLabelText("PR #7 - Draft: Linked change")).toBeVisible();
  await expect.element(screen.getByLabelText("PR #7, status pending")).not.toBeInTheDocument();
});

it("shows a subagent's pull request on a parent without its own, naming the subagent", async () => {
  appAtomRegistry.set(descendantsAtom, [
    { link, threadId: ThreadId.make("thread-subagent"), threadTitle: "Fix flaky test", depth: 1 },
  ]);
  await using screen = await render(
    <AppAtomRegistryProvider>
      <ChatPullRequestBadge
        thread={makeThreadFixture({
          environmentId,
          linkedPullRequest: null,
          branchPullRequest: null,
          pullRequests: [],
        })}
      />
    </AppAtomRegistryProvider>,
  );
  const badge = screen.getByLabelText("PR #7 - Merged: Linked change");
  await expect.element(badge).toBeVisible();

  await userEvent.hover(badge);
  await expect.element(page.getByText("From subagent Fix flaky test")).toBeInTheDocument();
});
