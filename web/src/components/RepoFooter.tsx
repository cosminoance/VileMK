import { REPO, REPO_URL } from "../lib/repo";
import { GitHubIcon } from "./Icons";

/** The foot of the sidebar: the project on GitHub and where to report a bug. */
export function RepoFooter() {
  return (
    <footer className="repofoot">
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer"
         title={`${REPO_URL}: source, releases and docs`}>
        <GitHubIcon />{REPO.replace("github.com/", "")}
      </a>
      <a href={`${REPO_URL}/issues/new`} target="_blank" rel="noopener noreferrer"
         title="Open a GitHub issue">report a bug</a>
    </footer>
  );
}
