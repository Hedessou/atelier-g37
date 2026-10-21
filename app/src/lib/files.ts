import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Enregistre un fichier produit par l'app (sauvegarde Excel, rapport PDF).
// Sur le téléphone : le fichier est écrit puis le menu « Partager » s'ouvre (WhatsApp, Drive, Fichiers…).
export async function saveBlob(blob: Blob, fileName: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const data = await blobToBase64(blob);
    const written = await Filesystem.writeFile({ path: fileName, data, directory: Directory.Cache });
    try {
      await Filesystem.writeFile({ path: `Atelier G37/${fileName}`, data, directory: Directory.Documents, recursive: true });
    } catch {
      // Dossier Documents indisponible sur certains téléphones : le partage reste possible.
    }
    await Share.share({ title: fileName, url: written.uri, dialogTitle: "Enregistrer ou envoyer le fichier" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
