// Copying to the clipboard without assuming a secure context.
//
// `navigator.clipboard` only exists on HTTPS or localhost. A Gateway reached over plain HTTP
// on a LAN address — which is how an on-prem instance is usually first accessed — has no
// clipboard object at all, so calling it directly throws "undefined is not an object" rather
// than failing gracefully. The execCommand path is deprecated but is the only thing that
// works there, and a robot secret shown once is precisely what a user cannot afford to fail
// to copy.

function copyViaSelection(text: string): boolean {
  const textarea = document.createElement("textarea")
  textarea.value = text
  // Kept off-screen and unfocusable-looking, but it must be in the document and selectable
  // for execCommand to see it.
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.top = "-9999px"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)

  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

/** Resolves true when the text reached the clipboard by either route. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or a transient failure — the fallback below may still work.
    }
  }

  return copyViaSelection(text)
}
