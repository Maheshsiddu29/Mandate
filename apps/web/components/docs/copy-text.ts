export async function copyText(value: string): Promise<boolean> {
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.inset = "0 auto auto -9999px";
  document.body.append(input);
  input.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    input.remove();
  }

  if (copied) return true;
  if (!navigator.clipboard?.writeText) return false;

  // Some embedded browsers expose the Clipboard API but leave its promise
  // pending. Bound that path so the control always reaches visible feedback.
  return Promise.race([
    navigator.clipboard.writeText(value).then(() => true, () => false),
    new Promise<false>((resolve) => window.setTimeout(() => resolve(false), 800)),
  ]);
}
