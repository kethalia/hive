// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { check, update } = vi.hoisted(() => ({ check: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/app-update", () => ({ checkAppVersion: check, refreshInstalledApp: update }));

import { AppUpdateSettings } from "@/components/app-update-settings";
import { APP_VERSION } from "@/lib/app-version";

const latest = { version: "9.0.0", buildId: "new-build" };

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);

describe("AppUpdateSettings", () => {
  it("shows the loaded version and requires a check before updating", () => {
    render(<AppUpdateSettings />);
    expect(screen.getByText(APP_VERSION.version)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update app" })).toBeDisabled();
    expect(check).not.toHaveBeenCalled();
  });

  it("reports when the installed app is current", async () => {
    check.mockResolvedValue(APP_VERSION);
    render(<AppUpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update app" })).toBeDisabled();
  });

  it("detects a new build with the same version and updates on request", async () => {
    check.mockResolvedValue({ ...APP_VERSION, buildId: "new-build" });
    update.mockResolvedValue(undefined);
    render(<AppUpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("An app update is available.");
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("shows a retryable check error without offering a stale update", async () => {
    check.mockResolvedValueOnce(latest).mockRejectedValueOnce(new Error("Offline"));
    render(<AppUpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("An app update is available.");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check for updates");
    expect(screen.getByRole("button", { name: "Update app" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("keeps the page open and permits retry when updating fails", async () => {
    check.mockResolvedValue(latest);
    update.mockRejectedValueOnce(new Error("Worker offline"));
    render(<AppUpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("An app update is available.");
    fireEvent.click(screen.getByRole("button", { name: "Update app" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update Hive");
    expect(screen.getByRole("button", { name: "Update app" })).toBeEnabled();
  });
});
