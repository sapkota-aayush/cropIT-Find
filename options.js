const keyInput = document.getElementById("key");
const tagInput = document.getElementById("tag");
const save = document.getElementById("save");
const status = document.getElementById("status");

chrome.storage.sync.get(["openaiApiKey", "amazonAssociateTag"], (data) => {
  if (data.openaiApiKey) keyInput.value = data.openaiApiKey;
  if (data.amazonAssociateTag) tagInput.value = data.amazonAssociateTag;
});

save.addEventListener("click", () => {
  const openaiApiKey = keyInput.value.trim();
  const amazonAssociateTag = tagInput.value.trim();
  chrome.storage.sync.set({ openaiApiKey, amazonAssociateTag }, () => {
    status.textContent = "Saved.";
  });
});
