const windowControlsPortalId = "windows-controls-portal";

export function getWindowControlsPortal(): HTMLDivElement {
  const existingPortal = document.getElementById(windowControlsPortalId);
  if (existingPortal instanceof HTMLDivElement) {
    return existingPortal;
  }

  const portal = document.createElement("div");
  portal.id = windowControlsPortalId;
  document.documentElement.appendChild(portal);
  return portal;
}
