import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { ru } from "./ru";
import { useSettingsStore } from "../stores/settingsStore";

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: useSettingsStore.getState().lang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

useSettingsStore.subscribe((state) => {
  if (i18n.language !== state.lang) void i18n.changeLanguage(state.lang);
});

export default i18n;
