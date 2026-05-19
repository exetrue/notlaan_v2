/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Search, MoreVertical, Lock, Unlock, Trash2, 
  ChevronLeft, ChevronRight, Save, Sparkles, Bell, Download, Upload,
  Key, LogOut, Check, AlertCircle, RefreshCw, Share2, 
  ShieldCheck, Cloud, Mail, FileJson, Calendar, Clock, Shield,
  Eye, EyeOff, Copy, CheckCircle, AlertTriangle, X, FileText,
  Sun, Moon, Edit3, ExternalLink, Globe, ShoppingBag, Settings,
  Wand2, Accessibility, Fingerprint, ShieldAlert
} from 'lucide-react';
import { animate, motion, AnimatePresence } from 'motion/react';
import CryptoJS from 'crypto-js';
import { GoogleGenAI } from "@google/genai";
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { Language, translations } from './translations';

// --- Constants & Types ---
const PIN_KEY = 'sn_pin_hash';
const NOTES_KEY = 'sn_notes_v2';
const REMINDERS_KEY = 'sn_reminders_v1';
const PASSWORDS_KEY = 'sn_passwords_v1';
const CATEGORIES_KEY = 'sn_categories_v1';
const THEME_KEY = 'sn_theme_v1';
const LANGUAGE_KEY = 'sn_language_v1';
const ELDERLY_MODE_KEY = 'sn_elderly_mode_v2';
const AUTO_LOCK_SECONDS = 60;

const generateStrongPassword = (length = 18) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  const cryptoObj = window.crypto || (window as any).msCrypto;
  const values = new Uint32Array(length);
  cryptoObj?.getRandomValues(values);
  return Array.from(values).map(v => chars[v % chars.length]).join('');
};

const passwordScore = (value = '') => {
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 14) score++;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  return score;
};

interface Alarm {
  id: string;
  date: string;
  time: string;
  label: string;
  triggered: boolean;
}

interface Category {
  id: string;
  name: string;
  color: string;
}

interface Note {
  id: string;
  title: string;
  body: string;
  date: string;
  updatedAt: number;
  alarms: Alarm[];
  categoryId?: string;
}

interface Reminder {
  id: string;
  title: string;
  time: string;
  date?: string; // If undefined, it's daily
  isDaily: boolean;
  completed: boolean;
  alarmEnabled: boolean;
  createdAt: number;
}

interface PasswordRecord {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  updatedAt: number;
}

type Screen = 'loading' | 'setup' | 'lock' | 'main';
type Section = 'notes' | 'reminders' | 'passwords' | 'settings' | 'edit_note';

// --- Encryption Helpers ---
const encrypt = (text: string, pin: string) => {
  return CryptoJS.AES.encrypt(text, pin).toString();
};

const decrypt = (ciphertext: string, pin: string) => {
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, pin);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    if (!result) return null;
    return result;
  } catch (e) {
    return null;
  }
};

const hashPin = (pin: string) => {
  return CryptoJS.SHA256(pin).toString();
};

// --- Main Component ---
export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [section, setSection] = useState<Section>('notes');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [language, setLanguage] = useState<Language>('tr');
  const [elderlyMode, setElderlyMode] = useState(false);
  
  const [notes, setNotes] = useState<Note[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [passwords, setPasswords] = useState<PasswordRecord[]>([]);
  
  const [search, setSearch] = useState('');
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [pin, setPin] = useState('');
  const [tempPin, setTempPin] = useState('');
  const [setupStep, setSetupStep] = useState(1);
  const [isPinVerifiedForSecrets, setIsPinVerifiedForSecrets] = useState(false);
  const [isChangingPin, setIsChangingPin] = useState(false);
  
  const [showAlarmPicker, setShowAlarmPicker] = useState(false);
  const [alarmForm, setAlarmForm] = useState({ date: '', time: '', label: '' });
  
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [reminderForm, setReminderForm] = useState<Partial<Reminder>>({ title: '', time: '', date: '', isDaily: false, alarmEnabled: true });
  
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState<Partial<PasswordRecord>>({ title: '', username: '', password: '', url: '', notes: '' });
  
  const [pendingSection, setPendingSection] = useState<Section | null>(null);
  const [showSecretAuth, setShowSecretAuth] = useState(false);
  const [showBackupMethods, setShowBackupMethods] = useState(false);
  
  const [aiLoading, setAiLoading] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [triggeredAlarms, setTriggeredAlarms] = useState<Set<string>>(new Set());
  const [activeAlarm, setActiveAlarm] = useState<{ noteTitle: string; label: string; id: string } | null>(null);
  const [editingAlarmId, setEditingAlarmId] = useState<string | null>(null);
  
  // --- Theme Sync ---
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    document.body.classList.toggle('elderly-mode', elderlyMode);
    localStorage.setItem(ELDERLY_MODE_KEY, elderlyMode ? '1' : '0');
  }, [elderlyMode]);

  const autoLockTimer = useRef<NodeJS.Timeout | null>(null);
  const ai = useRef<GoogleGenAI | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const t = (key: keyof typeof translations['tr']) => {
    return translations[language][key] || translations['tr'][key] || key;
  };

  // --- Alarm Checker ---
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      // Reset Daily Reminders if day changed
      const lastCheck = localStorage.getItem('last_alarm_reset_day');
      if (lastCheck !== nowStr) {
        let hasChanges = false;
        const updated = reminders.map(r => {
          if (r.isDaily && r.completed) {
            hasChanges = true;
            return { ...r, completed: false };
          }
          return r;
        });
        if (hasChanges) {
          setReminders(updated);
          saveData('reminders', updated, pin);
        }
        localStorage.setItem('last_alarm_reset_day', nowStr);
      }

      // 1. Note-specific Alarms
      notes.forEach(note => {
        note.alarms?.forEach(alarm => {
          const alarmId = `note-${note.id}-${alarm.date}-${alarm.time}`;
          if (alarm.date === nowStr && alarm.time === timeStr && !triggeredAlarms.has(alarmId)) {
            triggerAlarm(note.title || "İsimsiz Not", alarm.label, alarmId);
          }
        });
      });

      // 2. Global Reminders
      reminders.forEach(reminder => {
        if (reminder.completed || !reminder.alarmEnabled) return;
        const alarmId = `rem-${reminder.id}`;
        
        const isToday = reminder.isDaily || (reminder.date === nowStr);
        // Trigger if time matches or if it just became overdue (within the last minute check)
        if (isToday && reminder.time === timeStr && !triggeredAlarms.has(alarmId)) {
          triggerAlarm("Hatırlatma!", reminder.title, alarmId);
        }
      });
    }, 10000); 

    return () => clearInterval(interval);
  }, [notes, reminders, triggeredAlarms]);

  const triggerAlarm = (noteTitle: string, label: string, alarmId: string) => {
    setTriggeredAlarms(prev => new Set(prev).add(alarmId));
    setActiveAlarm({ noteTitle, label, id: alarmId });
    
    // Play Sound - Repeated beeps
    playAlarmSound();

    // Vibrate if on mobile
    if ("vibrate" in navigator) {
      navigator.vibrate([200, 100, 200, 100, 200, 100, 200]);
    }
  };

  const alarmIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const playAlarmSound = () => {
    if (alarmIntervalRef.current) clearInterval(alarmIntervalRef.current);
    
    const play = () => {
      try {
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume();
        }

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.6);
      } catch (e) {
        console.error("Audio error", e);
      }
    };

    play();
    alarmIntervalRef.current = setInterval(play, 1000);
  };

  useEffect(() => {
    if (!activeAlarm && alarmIntervalRef.current) {
      clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }
  }, [activeAlarm]);

  // --- AI Initialization ---
  useEffect(() => {
    if (process.env.GEMINI_API_KEY) {
      ai.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
  }, []);

  // --- Auto Lock Logic ---
  const resetAutoLock = useCallback(() => {
    if (autoLockTimer.current) clearTimeout(autoLockTimer.current);
    
    if (screen === 'main') {
      autoLockTimer.current = setTimeout(() => {
        setScreen('lock');
        setPin('');
        setIsPinVerifiedForSecrets(false);
      }, AUTO_LOCK_SECONDS * 1000);
    }
  }, [screen]);

  useEffect(() => {
    const handleActivity = () => resetAutoLock();
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keydown', handleActivity);
    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      if (autoLockTimer.current) clearTimeout(autoLockTimer.current);
    };
  }, [resetAutoLock]);

  // --- Initialization ---
  useEffect(() => {
    const savedPinHash = localStorage.getItem(PIN_KEY);
    if (!savedPinHash) {
      setScreen('setup');
    } else {
      setScreen('lock');
    }
  }, []);

  const loadData = (userPin: string) => {
    try {
      // Load Theme
      const savedTheme = localStorage.getItem(THEME_KEY);
      if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);

      // Load Language
      const savedLang = localStorage.getItem(LANGUAGE_KEY) as Language;
      if (savedLang && translations[savedLang]) setLanguage(savedLang);

      // Load accessibility mode
      setElderlyMode(localStorage.getItem(ELDERLY_MODE_KEY) === '1');

      // Load Categories
      const categoriesRaw = localStorage.getItem(CATEGORIES_KEY);
      if (categoriesRaw) {
        const decrypted = decrypt(categoriesRaw, userPin);
        if (decrypted) setCategories(JSON.parse(decrypted));
      } else {
        // Default categories
        const defaultCats = [
          { id: 'personal', name: 'Kişisel', color: '#6366f1' },
          { id: 'work', name: 'İş', color: '#f59e0b' },
          { id: 'ideas', name: 'Fikirler', color: '#10b981' }
        ];
        setCategories(defaultCats);
        saveData('categories', defaultCats, userPin);
      }

      // Load Notes
      const notesRaw = localStorage.getItem(NOTES_KEY);
      if (notesRaw) {
        const decrypted = decrypt(notesRaw, userPin);
        if (decrypted) setNotes(JSON.parse(decrypted));
      }

      // Load Reminders
      const remRaw = localStorage.getItem(REMINDERS_KEY);
      if (remRaw) {
        const decrypted = decrypt(remRaw, userPin);
        if (decrypted) setReminders(JSON.parse(decrypted));
      }

      // Load Passwords
      const passRaw = localStorage.getItem(PASSWORDS_KEY);
      if (passRaw) {
        const decrypted = decrypt(passRaw, userPin);
        if (decrypted) setPasswords(JSON.parse(decrypted));
      }

      return true;
    } catch (e) {
      console.error("Failed to load data", e);
      return false;
    }
  };

  const saveData = (type: 'notes' | 'reminders' | 'passwords' | 'categories', list: any[], userPin: string) => {
    try {
      const key = type === 'notes' ? NOTES_KEY : 
                  type === 'reminders' ? REMINDERS_KEY : 
                  type === 'passwords' ? PASSWORDS_KEY : 
                  CATEGORIES_KEY;
      const encrypted = encrypt(JSON.stringify(list), userPin);
      localStorage.setItem(key, encrypted);
    } catch (e) {
      console.error(`Failed to save ${type}`, e);
    }
  };

  // --- Actions ---
  const handlePinSubmit = (val: string) => {
    if (isChangingPin) {
      if (setupStep === 1) {
        setTempPin(val);
        setSetupStep(2);
      } else {
        if (val === tempPin) {
          handleMigratePin(val);
          setSetupStep(1);
          setTempPin('');
        } else {
          alert(t('pinMismatch'));
          setSetupStep(1);
          setTempPin('');
        }
      }
      return;
    }

    if (showSecretAuth) {
      const savedHash = localStorage.getItem(PIN_KEY);
      if (hashPin(val) === savedHash) {
        setIsPinVerifiedForSecrets(true);
        setShowSecretAuth(false);
        setPin(val);
        if (pendingSection) {
          setSection(pendingSection);
          setPendingSection(null);
        }
      } else {
        alert(t('wrongPin'));
      }
      return;
    }

    if (screen === 'setup') {
      if (setupStep === 1) {
        setTempPin(val);
        setSetupStep(2);
      } else {
        if (val === tempPin) {
          localStorage.setItem(PIN_KEY, hashPin(val));
          setPin(val);
          setNotes([]);
          setReminders([]);
          setPasswords([]);
          setScreen('main');
        } else {
          alert(t('pinMismatch'));
          setSetupStep(1);
          setTempPin('');
        }
      }
    } else if (screen === 'lock') {
      const savedHash = localStorage.getItem(PIN_KEY);
      if (hashPin(val) === savedHash) {
        if (loadData(val)) {
          setPin(val);
          setScreen('main');
        } else {
          alert(t('dataError'));
        }
      } else {
        alert(t('wrongPin'));
      }
    }
  };

  const handleMigratePin = (newPin: string) => {
    try {
      saveData('notes', notes, newPin);
      saveData('reminders', reminders, newPin);
      saveData('passwords', passwords, newPin);
      saveData('categories', categories, newPin);
      
      localStorage.setItem(PIN_KEY, hashPin(newPin));
      setPin(newPin);
      setIsChangingPin(false);
      alert(t('pinChanged'));
    } catch (e) {
      console.error("Migration failed", e);
      alert("Hata: PIN değiştirilemedi.");
    }
  };

  // --- Backup/Restore ---
  const prepareBackup = async () => {
    if (!pin) {
      alert("Lütfen önce bir PIN oluşturun.");
      return null;
    }

    try {
      const rawData = {
        notes,
        reminders,
        passwords,
        categories,
        pinHash: localStorage.getItem(PIN_KEY),
        exportedAt: new Date().toISOString()
      };
      
      const jsonStr = JSON.stringify(rawData);
      const encryptedData = CryptoJS.AES.encrypt(jsonStr, pin).toString();
      
      const backupWrapper = {
        version: "2.0",
        encrypted: true,
        cipher: "AES-256",
        payload: encryptedData
      };
      
      return {
        json: JSON.stringify(backupWrapper, null, 2),
        fileName: `NOTLAAN_Yedek_${new Date().toISOString().split('T')[0]}.json`
      };
    } catch (err) {
      console.error('Backup prep failed', err);
      return null;
    }
  };

  const shareBackup = async (method: 'drive' | 'whatsapp' | 'email' | 'local') => {
    setIsBackingUp(true);
    const backup = await prepareBackup();
    if (!backup) {
      setIsBackingUp(false);
      return;
    }

    const shareTitle = 'NOTLAAN - Şifreli Yedek';
    const shareText = '256-bit AES şifreli yedek dosyası. Geri yüklemek için mevcut PIN kodunuz gereklidir.';

    // Native Platform (Android/iOS App)
    if (Capacitor.isNativePlatform()) {
      try {
        const result = await Filesystem.writeFile({
          path: backup.fileName,
          data: backup.json,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });

        await Share.share({
          title: shareTitle,
          text: shareText,
          url: result.uri,
          dialogTitle: 'Yedeği Kaydet veya Paylaş',
        });
        setIsBackingUp(false);
        setShowBackupMethods(false);
        return;
      } catch (err) {
        console.error('Native share failed', err);
      }
    }

    // Modern Browsers with Web Share API (Mobile Chrome/Safari etc)
    if (method !== 'local' && navigator.share && navigator.canShare) {
      const blob = new Blob([backup.json], { type: 'application/json' });
      const file = new File([blob], backup.fileName, { type: 'application/json' });
      
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: shareTitle,
            text: shareText,
            files: [file],
          });
          setIsBackingUp(false);
          setShowBackupMethods(false);
          return;
        } catch (e) {
          console.log('Share cancelled or failed', e);
          // If user cancels, we don't necessarily want to download automatically
          if ((e as Error).name === 'AbortError') {
            setIsBackingUp(false);
            return;
          }
        }
      }
    }

    // Desktop Fallback or Specific Web Handling
    if (method === 'local') {
      downloadFallback(backup.json, backup.fileName, "Yedek dosyası yerel diskinize indirildi.");
    } else {
      // For Drive, WhatsApp, Email icons on Desktop
      const methodNames = { drive: 'Google Drive', whatsapp: 'WhatsApp', email: 'E-Posta' };
      downloadFallback(
        backup.json, 
        backup.fileName, 
        `Masaüstü tarayıcıda doğrudan ${methodNames[method]} paylaşımı yapılamaz. Yedek dosyası indirildi, lütfen ${methodNames[method]}'a manuel olarak yükleyin.`
      );
    }
    
    setIsBackingUp(false);
    setShowBackupMethods(false);
  };

  const downloadFallback = (content: string, fileName: string, message: string) => {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    alert(message);
  };

  const handleRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const backupData = JSON.parse(content);
        
        let finalData: any = null;

        if (backupData.encrypted && backupData.payload) {
          // Attempt to decrypt with current PIN
          try {
            const bytes = CryptoJS.AES.decrypt(backupData.payload, pin);
            const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
            if (!decryptedStr) throw new Error("Wrong PIN");
            finalData = JSON.parse(decryptedStr);
          } catch (e) {
            // If decryption fails, maybe the backup was from a different PIN
            const backupPin = prompt("Bu yedek dosyası şifreli. Lütfen yedeğin alındığı PIN kodunu girin:");
            if (!backupPin) return;
            
            const bytes = CryptoJS.AES.decrypt(backupData.payload, backupPin);
            const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
            if (!decryptedStr) {
              alert("Hatalı PIN! Yedek açılamadı.");
              return;
            }
            finalData = JSON.parse(decryptedStr);
          }
        } else {
          // Legacy non-encrypted backup support
          finalData = backupData;
        }

        if (finalData && finalData.notes && Array.isArray(finalData.notes)) {
          if (confirm("Veriler başarıyla çözüldü. Geri yüklensin mi? Mevcut tüm verileriniz (notlar, hatırlatıcılar, şifreler, kategoriler) silinecek ve yedektekilerle değiştirilecektir.")) {
            // Restore all data types
            if (finalData.notes) {
              setNotes(finalData.notes);
              saveData('notes', finalData.notes, pin);
            }
            if (finalData.reminders) {
              setReminders(finalData.reminders);
              saveData('reminders', finalData.reminders, pin);
            }
            if (finalData.passwords) {
              setPasswords(finalData.passwords);
              saveData('passwords', finalData.passwords, pin);
            }
            if (finalData.categories) {
              setCategories(finalData.categories);
              saveData('categories', finalData.categories, pin);
            }
            
            alert("Yedek başarıyla geri yüklendi!");
          }
        } else {
          alert("Geçersiz yedek dosyası formatı.");
        }
      } catch (err) {
        console.error('Restore error:', err);
        alert("Dosya okuma veya şifre çözme hatası.");
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const addNote = () => {
    const newNote: Note = {
      id: Date.now().toString(),
      title: '',
      body: '',
      date: new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }),
      updatedAt: Date.now(),
      alarms: []
    };
    setActiveNote(newNote);
    setSection('edit_note');
  };

  const deleteNote = (id: string) => {
    if (window.confirm("Bu notu silmek istediğinize emin misiniz?")) {
      const updated = notes.filter(n => n.id !== id);
      setNotes(updated);
      saveData('notes', updated, pin);
    }
  };

  const saveNote = (note: Note) => {
    const exists = notes.find(n => n.id === note.id);
    let updatedNotes: Note[];
    
    if (exists) {
      updatedNotes = notes.map(n => n.id === note.id ? { ...note, updatedAt: Date.now() } : n);
    } else {
      updatedNotes = [{ ...note, updatedAt: Date.now() }, ...notes];
    }
    
    setNotes(updatedNotes);
    saveData('notes', updatedNotes, pin);
    setSection('notes');
    setActiveNote(null);
  };

  // --- Alarms ---
  const addAlarm = () => {
    if (!activeNote || !alarmForm.date || !alarmForm.time) return;
    
    let updatedAlarms: Alarm[];
    if (editingAlarmId) {
      updatedAlarms = activeNote.alarms.map(a => 
        a.id === editingAlarmId ? { ...a, ...alarmForm, triggered: false } : a
      );
    } else {
      const newAlarm: Alarm = {
        id: Date.now().toString(),
        ...alarmForm,
        triggered: false
      };
      updatedAlarms = [...(activeNote.alarms || []), newAlarm];
    }
    
    setActiveNote({ ...activeNote, alarms: updatedAlarms });
    setShowAlarmPicker(false);
    setEditingAlarmId(null);
    setAlarmForm({ date: '', time: '', label: '' });
  };

  const editAlarm = (alarm: Alarm) => {
    setAlarmForm({ date: alarm.date, time: alarm.time, label: alarm.label });
    setEditingAlarmId(alarm.id);
    setShowAlarmPicker(true);
  };

  const deleteAlarm = (alarmId: string) => {
    if (!activeNote) return;
    const updated = activeNote.alarms.filter(a => a.id !== alarmId);
    setActiveNote({ ...activeNote, alarms: updated });
  };

  // --- Reminders Section Helpers ---
  const saveReminder = () => {
    if (!reminderForm.title || !reminderForm.time) return;
    
    let updated: Reminder[];
    if (reminderForm.id) {
      updated = reminders.map(r => r.id === reminderForm.id ? { ...r, ...reminderForm } as Reminder : r);
    } else {
      const newRem: Reminder = {
        id: Date.now().toString(),
        title: reminderForm.title!,
        time: reminderForm.time!,
        date: reminderForm.isDaily ? undefined : reminderForm.date,
        isDaily: reminderForm.isDaily || false,
        completed: false,
        alarmEnabled: reminderForm.alarmEnabled ?? true,
        createdAt: Date.now()
      };
      updated = [newRem, ...reminders];
    }
    
    setReminders(updated);
    saveData('reminders', updated, pin);
    setShowReminderModal(false);
    setReminderForm({ title: '', time: '', date: '', isDaily: false, alarmEnabled: true });
  };

  const toggleReminder = (id: string) => {
    const updated = reminders.map(r => r.id === id ? { ...r, completed: !r.completed } : r);
    setReminders(updated);
    saveData('reminders', updated, pin);
  };

  const deleteReminder = (id: string) => {
    if (window.confirm("Bu hatırlatmayı silmek istediğinize emin misiniz?")) {
      const updated = reminders.filter(r => r.id !== id);
      setReminders(updated);
      saveData('reminders', updated, pin);
    }
  };

  // --- Passwords Section Helpers ---
  const handleSecretAccess = (targetSection: Section) => {
    if (isPinVerifiedForSecrets) {
      setSection(targetSection);
    } else {
      setPendingSection(targetSection);
      setShowSecretAuth(true);
    }
  };

  const savePassword = () => {
    if (!passwordForm.title) return;
    
    let updated: PasswordRecord[];
    const entry = { ...passwordForm, updatedAt: Date.now() };
    
    if (passwordForm.id) {
      updated = passwords.map(p => p.id === passwordForm.id ? { ...p, ...entry } as PasswordRecord : p);
    } else {
      const newPass: PasswordRecord = {
        id: Date.now().toString(),
        title: passwordForm.title!,
        username: passwordForm.username || '',
        password: passwordForm.password || '',
        url: passwordForm.url || '',
        notes: passwordForm.notes || '',
        updatedAt: Date.now()
      };
      updated = [newPass, ...passwords];
    }
    
    setPasswords(updated);
    saveData('passwords', updated, pin);
    setShowPasswordModal(false);
    setPasswordForm({ title: '', username: '', password: '', url: '', notes: '' });
  };

  const deletePassword = (id: string) => {
    if (window.confirm("Bu şifre kaydını silmek istediğinize emin misiniz?")) {
      const updated = passwords.filter(p => p.id !== id);
      setPasswords(updated);
      saveData('passwords', updated, pin);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    window.setTimeout(() => navigator.clipboard.writeText(''), 30000);
  };

  const fillGeneratedPassword = () => {
    setPasswordForm({...passwordForm, password: generateStrongPassword(18)});
  };

  const tryBiometricUnlock = async () => {
    alert('V2 hazırlığı: Biyometrik giriş için native plugin bağlantısı hazırlandı. APK derlemede capacitor-native-biometric eklenince aktif edilir.');
  };
  const checkTextWithAI = async () => {
    if (!ai.current || !activeNote) return;
    setAiLoading(true);
    try {
      const response = await ai.current.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Aşağıdaki not içeriğindeki yazım ve imla hatalarını bul ve düzelt. Sadece düzeltilmiş metni geri döndür, başka açıklama yapma: \n\n ${activeNote.body}`
      });
      const fixedText = response.text || activeNote.body;
      setActiveNote({ ...activeNote, body: fixedText });
    } catch (e) {
      console.error("AI error", e);
      alert("AI servisine ulaşılamadı.");
    } finally {
      setAiLoading(false);
    }
  };

  // --- Theme Effect ---
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // --- Language Effect ---
  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
  }, [language]);

  // --- Render Helpers ---
  const filteredNotes = notes.filter(n => 
    (n.title + n.body).toLowerCase().includes(search.toLowerCase())
  );

  const highlightText = (text: string, highlight: string) => {
    if (!highlight.trim()) return text;
    const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
    return (
      <>
        {parts.map((part, i) => 
          part.toLowerCase() === highlight.toLowerCase() 
            ? <mark key={i} className="bg-accent/30 text-accent rounded-sm px-0.5">{part}</mark>
            : part
        )}
      </>
    );
  };

  if (screen === 'loading') {
    return (
      <div className="h-screen bg-bg flex flex-col items-center justify-center gap-6">
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="relative"
        >
          <RefreshCw size={48} className="text-accent animate-spin" />
        </motion.div>
        <motion.div 
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
          className="text-accent font-black text-xs uppercase tracking-widest"
        >
          {t('loading')}
        </motion.div>
      </div>
    );
  }

  if (screen === 'setup' || screen === 'lock') {
    return <PinScreen 
      step={screen === 'setup' ? setupStep : 0} 
      onDone={handlePinSubmit} 
      title={screen === 'setup' ? (setupStep === 1 ? t('setupPin') : t('confirmPin')) : t('welcome')}
      subtitle={screen === 'setup' ? t('secretSubtitle') : t('enterPin')}
      t={t}
    />;
  }

  if (section === 'edit_note' && activeNote) {
    const wordCount = activeNote.body.trim() ? activeNote.body.trim().split(/\s+/).length : 0;
    const charCount = activeNote.body.length;

    return (
      <div className="min-h-screen bg-bg flex flex-col text-[var(--text-main)]">
        <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-border flex items-center justify-between sticky top-0 bg-bg z-10">
          <button onClick={() => { setSection('notes'); setActiveNote(null); }} className="p-2 -ml-2 hover:bg-surface rounded-full transition-colors">
            <ChevronLeft size={28} className="sm:w-8 sm:h-8" />
          </button>
          <div className="flex gap-1 sm:gap-2">
            <button 
              onClick={() => {
                if (window.confirm(t('deleteConfirm'))) {
                  deleteNote(activeNote.id);
                  setSection('notes');
                  setActiveNote(null);
                }
              }}
              className="p-2 sm:p-3 text-text-muted hover:text-red-500 transition-colors"
              title={t('delete')}
            >
              <Trash2 size={20} className="sm:w-6 sm:h-6" />
            </button>
            <button 
              onClick={checkTextWithAI}
              disabled={aiLoading || !activeNote.body}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-accent-soft text-accent rounded-2xl hover:bg-accent hover:text-white transition-all disabled:opacity-50 text-xs sm:text-sm"
            >
              {aiLoading ? <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" /> : <Sparkles className="w-4 h-4 sm:w-5 sm:h-5" />}
              <span className="font-black hidden sm:inline uppercase">AI</span>
            </button>
            <button 
              onClick={() => saveNote(activeNote)}
              className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-accent text-white rounded-2xl font-black shadow-lg shadow-accent/20 active:scale-95 transition-all text-sm sm:text-base"
            >
              <Save size={18} className="sm:w-5 sm:h-5" />
              {t('save')}
            </button>
          </div>
        </header>

        <main className="flex-1 max-w-3xl mx-auto w-full p-4 sm:p-6 space-y-4 sm:space-y-6 pb-40">
          <div className="space-y-4">
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
              {categories.map((cat: any) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveNote({ ...activeNote, categoryId: activeNote.categoryId === cat.id ? undefined : cat.id })}
                  className={`px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest whitespace-nowrap transition-all border-2 flex items-center gap-2 ${activeNote.categoryId === cat.id ? 'text-white shadow-lg shadow-accent/20' : 'bg-surface border-border text-text-muted hover:border-accent/40'}`}
                  style={activeNote.categoryId === cat.id ? { backgroundColor: cat.color, borderColor: cat.color } : {}}
                >
                  <div className="w-2 h-2 rounded-full bg-current opacity-50" />
                  {cat.name}
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <p className="text-[9px] sm:text-[10px] font-black text-text-muted uppercase tracking-[0.2em] px-1">
                 {new Date(activeNote.updatedAt).toLocaleString(t('locale'), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
              </p>
              <input 
                autoFocus
                className="w-full bg-transparent text-2xl sm:text-4xl font-black placeholder:text-text-muted border-none outline-none tracking-tight"
                placeholder={t('title')}
                value={activeNote.title}
                onChange={e => setActiveNote({...activeNote, title: e.target.value})}
              />
            </div>
          </div>
          
          <div className="relative">
            <textarea 
              className="w-full bg-transparent text-lg sm:text-xl text-[var(--text-main)] leading-relaxed opacity-90 placeholder:text-text-muted border-none outline-none resize-none min-h-[40vh]"
              placeholder={t('content')}
              value={activeNote.body}
              onChange={e => setActiveNote({...activeNote, body: e.target.value})}
            />
            <div className="flex gap-4 text-[9px] sm:text-[10px] font-black text-text-muted uppercase tracking-widest mt-4">
              <span>{wordCount} {t('wordCount')}</span>
              <span>{charCount} {t('charCount')}</span>
            </div>
          </div>
          
          <div className="pt-8 border-t-2 border-border/50">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-black uppercase tracking-wider text-text-main flex items-center gap-2">
                <Bell size={18} className="text-accent" /> {t('reminders')}
              </h3>
              <button 
                onClick={() => setShowAlarmPicker(true)}
                className="text-xs font-black bg-surface border-2 border-border text-text-main px-4 py-2 rounded-2xl active:bg-accent active:text-white transition-all shadow-sm"
              >
                {t('addAlarm')}
              </button>
            </div>
            
            {activeNote.alarms?.length === 0 ? (
              <p className="text-sm text-text-muted italic">{t('noAlarms')}</p>
            ) : (
              <div className="space-y-3">
                {activeNote.alarms?.map(alarm => (
                  <div key={alarm.id} className="flex items-center justify-between p-4 bg-surface rounded-2xl border border-border group shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${alarm.triggered ? 'bg-text-muted' : 'bg-green-400 animate-pulse'}`} />
                      <div>
                        <p className={`text-lg font-bold ${alarm.triggered ? 'text-text-muted line-through' : ''}`}>
                          {alarm.date} {alarm.time}
                        </p>
                        {alarm.label && <p className="text-sm text-text-muted">{alarm.label}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => editAlarm(alarm)} className="p-3 text-accent active:bg-accent/20 rounded-xl transition-colors">
                        <Edit3 className="w-6 h-6" />
                      </button>
                      <button onClick={() => deleteAlarm(alarm.id)} className="p-3 text-red-500 active:bg-red-400/20 rounded-xl transition-colors">
                        <Trash2 className="w-6 h-6" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>

        <AnimatePresence>
          {showAlarmPicker && (
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                className="bg-surface w-full max-w-sm rounded-[40px] p-8 border border-border shadow-2xl"
              >
                <h2 className="text-2xl font-black mb-8 text-center">⏰ {editingAlarmId ? t('editNote') : t('reminder')}</h2>
                <div className="space-y-6">
                  <div>
                    <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('date')}</label>
                    <input 
                      type="date"
                      className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-lg font-bold outline-none focus:border-accent"
                      value={alarmForm.date}
                      onChange={e => setAlarmForm({...alarmForm, date: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('time')}</label>
                    <input 
                      type="time"
                      className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-lg font-bold outline-none focus:border-accent"
                      value={alarmForm.time}
                      onChange={e => setAlarmForm({...alarmForm, time: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('label')}</label>
                    <input 
                      type="text"
                      placeholder="..."
                      className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-lg font-bold outline-none focus:border-accent"
                      value={alarmForm.label}
                      onChange={e => setAlarmForm({...alarmForm, label: e.target.value})}
                    />
                  </div>
                </div>
                
                <div className="flex gap-4 mt-10">
                  <button onClick={() => { setShowAlarmPicker(false); setEditingAlarmId(null); setAlarmForm({ date: '', time: '', label: '' }); }} className="flex-1 py-4 bg-bg rounded-2xl font-black text-text-muted hover:bg-surface transition-colors border border-border">{t('cancel')}</button>
                  <button onClick={addAlarm} className="flex-1 py-4 bg-accent text-white rounded-2xl font-black shadow-lg shadow-accent/40 active:scale-95 transition-transform">{t('save')}</button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-[var(--text-main)] flex flex-col">
      {/* Header */}
      <header className="px-5 py-6 sm:py-8 flex items-center justify-between sticky top-0 bg-bg/95 backdrop-blur-xl z-40">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-surface rounded-xl shadow-sm flex items-center justify-center border border-border overflow-hidden p-1 text-2xl">
            🔐📘
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {section === 'notes' && t('notes')}
            {section === 'reminders' && t('reminders')}
            {section === 'passwords' && t('passwords')}
            {section === 'settings' && t('settings')}
            {section === 'edit_note' && t('editNote')}
          </h1>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="w-11 h-11 flex items-center justify-center bg-surface rounded-full border border-border shadow-sm active:scale-90 transition-all"
          >
            {theme === 'dark' ? <Sun size={20} className="text-yellow-500" /> : <Moon size={20} className="text-accent" />}
          </button>
          <button 
            onClick={() => { setScreen('lock'); setPin(''); setIsPinVerifiedForSecrets(false); }}
            className="w-11 h-11 flex items-center justify-center bg-surface rounded-full border border-border shadow-sm active:scale-90 transition-all text-red-500"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 sm:px-6 pb-40 max-w-4xl mx-auto w-full relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={section}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="w-full h-full"
          >
            {section === 'notes' && (
              <NotesSection 
                search={search}
                setSearch={setSearch}
                notes={notes}
                categories={categories}
                highlightText={highlightText}
                onAdd={addNote}
                onEdit={(note: any) => { setActiveNote(note); setSection('edit_note'); }}
                onDelete={deleteNote}
                t={t}
              />
            )}
            {section === 'reminders' && (
              <RemindersSection 
                reminders={reminders}
                onAdd={() => setShowReminderModal(true)}
                onToggle={toggleReminder}
                onDelete={deleteReminder}
                onEdit={(rem) => { setReminderForm(rem); setShowReminderModal(true); }}
                t={t}
              />
            )}
            {section === 'passwords' && (
              <PasswordsSection 
                passwords={passwords}
                onAdd={() => setShowPasswordModal(true)}
                onDelete={deletePassword}
                onEdit={(pass) => { setPasswordForm(pass); setShowPasswordModal(true); }}
                onCopy={copyToClipboard}
                t={t}
              />
            )}
            {section === 'settings' && (
              <SettingsSection 
                notes={notes}
                categories={categories}
                setCategories={setCategories}
                saveData={saveData}
                pin={pin}
                isBackingUp={isBackingUp}
                showBackupMethods={showBackupMethods}
                setShowBackupMethods={setShowBackupMethods}
                shareBackup={shareBackup}
                handleFilesystemRestore={() => fileInputRef.current?.click()}
                fileInputRef={fileInputRef}
                handleRestore={handleRestore}
                theme={theme}
                setTheme={setTheme}
                t={t}
                language={language}
                setLanguage={setLanguage}
                startChangePin={() => { setSetupStep(1); setTempPin(''); setIsChangingPin(true); }}
                elderlyMode={elderlyMode}
                setElderlyMode={setElderlyMode}
                tryBiometricUnlock={tryBiometricUnlock}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-surface border-t border-border px-6 py-4 flex items-center justify-between z-50">
        <NavButton active={section === 'notes'} onClick={() => setSection('notes')} icon={<FileText />} label={t('notes')} />
        <NavButton active={section === 'reminders'} onClick={() => setSection('reminders')} icon={<Bell />} label={t('reminders')} />
        <NavButton active={section === 'passwords'} onClick={() => handleSecretAccess('passwords')} icon={<Shield />} label={t('passwords')} />
        <NavButton active={section === 'settings'} onClick={() => setSection('settings')} icon={<Settings />} label={t('settings')} />
      </nav>

      {/* Secret Auth Modal */}
      <AnimatePresence>
        {showSecretAuth && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-bg/95 z-[200] flex items-center justify-center p-6 backdrop-blur-xl"
          >
            <PinScreen 
              step={0}
              onDone={handlePinSubmit}
              title={t('secretZone')}
              subtitle={t('secretSubtitle')}
              t={t}
            />
            <button 
              onClick={() => setShowSecretAuth(false)}
              className="absolute top-10 right-10 p-4 text-text-main hover:bg-surface/50 rounded-full transition-colors"
            >
              <X size={32} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Change PIN Modal */}
      <AnimatePresence>
        {isChangingPin && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-bg/95 z-[200] flex items-center justify-center p-6 backdrop-blur-xl"
          >
            <PinScreen 
              step={setupStep}
              onDone={handlePinSubmit}
              title={t('changePin')}
              subtitle={setupStep === 1 ? t('setupPin') : t('confirmPin')}
              t={t}
            />
            <button 
              onClick={() => setIsChangingPin(false)}
              className="absolute top-10 right-10 p-4 text-text-main hover:bg-surface/50 rounded-full transition-colors"
            >
              <X size={32} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Alarm Modal */}
      <AnimatePresence>
        {activeAlarm && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-bg/95 flex items-center justify-center p-6 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-red-500 p-8 rounded-[40px] w-full max-w-sm text-center shadow-2xl border border-white/20"
            >
              <div className="w-24 h-24 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-6 relative">
                <Bell className="w-12 h-12 text-white animate-bounce" />
                <motion.div 
                  animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="absolute inset-0 bg-white rounded-full"
                />
              </div>
              <h2 className="text-4xl font-black text-white mb-2 uppercase italic tracking-tighter">ALARM!</h2>
              <div className="bg-black/20 p-4 rounded-3xl mb-8">
                <p className="text-white text-xl font-black mb-1 line-clamp-2 uppercase">{activeAlarm.noteTitle}</p>
                {activeAlarm.label && (
                  <p className="text-white/80 text-sm font-bold truncate">"{activeAlarm.label}"</p>
                )}
              </div>
              <button 
                onClick={() => setActiveAlarm(null)}
                className="w-full py-5 bg-white text-red-500 rounded-3xl font-black text-xl shadow-2xl active:scale-95 transition-transform uppercase tracking-widest"
              >
                {t('completed')}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Global Reminder Modal */}
      <AnimatePresence>
        {showReminderModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }}
              className="bg-surface w-full max-w-md rounded-[40px] p-8 border border-border shadow-2xl"
            >
              <h2 className="text-2xl font-black mb-8 text-center">🔔 {t('reminder')}</h2>
              <div className="space-y-6">
                <div>
                  <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('title')}</label>
                  <input 
                    type="text"
                    autoFocus
                    className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-xl font-bold outline-none focus:border-accent"
                    placeholder="..."
                    value={reminderForm.title}
                    onChange={e => setReminderForm({...reminderForm, title: e.target.value})}
                  />
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-black text-text-muted block mb-3 uppercase tracking-widest">{t('type')}</label>
                    <div className="grid grid-cols-2 gap-3 p-1.5 bg-bg rounded-2xl border-2 border-border">
                      <button 
                        onClick={() => setReminderForm({...reminderForm, isDaily: true})}
                        className={`py-3 rounded-xl font-black text-sm transition-all ${reminderForm.isDaily ? 'bg-accent text-white shadow-lg' : 'text-text-muted hover:bg-surface/50'}`}
                      >
                        {t('daily')}
                      </button>
                      <button 
                        onClick={() => setReminderForm({...reminderForm, isDaily: false})}
                        className={`py-3 rounded-xl font-black text-sm transition-all ${!reminderForm.isDaily ? 'bg-accent text-white shadow-lg' : 'text-text-muted hover:bg-surface/50'}`}
                      >
                        {t('dated')}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('time')}</label>
                    <input 
                      type="time"
                      className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-xl font-bold outline-none focus:border-accent"
                      value={reminderForm.time}
                      onChange={e => setReminderForm({...reminderForm, time: e.target.value})}
                    />
                  </div>
                </div>
                {!reminderForm.isDaily && (
                  <div>
                    <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('date')}</label>
                    <input 
                      type="date"
                      className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-xl font-bold outline-none"
                      value={reminderForm.date}
                      onChange={e => setReminderForm({...reminderForm, date: e.target.value})}
                    />
                  </div>
                )}

                <div className="flex items-center justify-between p-4 bg-bg rounded-2xl border-2 border-border">
                  <div className="flex items-center gap-3">
                    <Bell className={reminderForm.alarmEnabled ? 'text-accent' : 'text-text-muted'} />
                    <span className="font-bold text-sm uppercase tracking-tight">{t('alarm')}</span>
                  </div>
                  <button 
                    onClick={() => setReminderForm({...reminderForm, alarmEnabled: !reminderForm.alarmEnabled})}
                    className={`w-14 h-8 rounded-full p-1 transition-all ${reminderForm.alarmEnabled ? 'bg-accent' : 'bg-gray-400'}`}
                  >
                    <div className={`w-6 h-6 rounded-full bg-white shadow-sm transition-all ${reminderForm.alarmEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>
              <div className="flex gap-4 mt-10">
                <button 
                  onClick={() => { setShowReminderModal(false); setReminderForm({ title: '', time: '', date: '', isDaily: false, alarmEnabled: true }); }}
                  className="flex-1 py-4 bg-bg rounded-2xl font-black text-text-muted border border-border"
                >
                  {t('cancel')}
                </button>
                <button onClick={saveReminder} className="flex-1 py-4 bg-accent text-white rounded-2xl font-black shadow-lg shadow-accent/40">
                  {t('save')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Password Modal */}
      <AnimatePresence>
        {showPasswordModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }}
              className="bg-surface w-full max-w-md rounded-[40px] p-8 border border-border shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <h2 className="text-2xl font-black mb-8 text-center">🔐 {t('passwords')}</h2>
              <div className="space-y-4">
                <InputField label={t('title')} value={passwordForm.title} onChange={(v: string) => setPasswordForm({...passwordForm, title: v})} />
                <InputField label={t('username')} value={passwordForm.username} onChange={(v: string) => setPasswordForm({...passwordForm, username: v})} />
                <div className="space-y-2">
                  <InputField label={t('password')} type="text" value={passwordForm.password} onChange={(v: string) => setPasswordForm({...passwordForm, password: v})} />
                  <div className="flex items-center gap-2">
                    <button onClick={fillGeneratedPassword} className="flex items-center gap-2 px-4 py-3 bg-accent-soft text-accent rounded-2xl font-black text-xs"><Wand2 size={16}/> Güçlü Şifre Üret</button>
                    <span className="text-xs font-black text-text-muted">Güç: {passwordScore(passwordForm.password || '')}/5</span>
                  </div>
                </div>
                <InputField label={t('url')} value={passwordForm.url} onChange={(v: string) => setPasswordForm({...passwordForm, url: v})} />
                <div>
                  <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{t('notes')}</label>
                  <textarea 
                    className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-lg font-bold outline-none resize-none"
                    value={passwordForm.notes} rows={3}
                    onChange={e => setPasswordForm({...passwordForm, notes: e.target.value})}
                    placeholder={t('notes_placeholder')}
                  />
                </div>
              </div>
              <div className="flex gap-4 mt-8">
                <button onClick={() => { setShowPasswordModal(false); setPasswordForm({ title: '', username: '', password: '', url: '', notes: '' }); }} className="flex-1 py-4 bg-bg rounded-2xl font-black text-text-muted border border-border">{t('cancel')}</button>
                <button onClick={savePassword} className="flex-1 py-4 bg-accent text-white rounded-2xl font-black shadow-lg shadow-accent/40">{t('save')}</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function InputField({ label, value, onChange, type = "text" }: any) {
  return (
    <div>
      <label className="text-xs font-black text-text-muted block mb-2 uppercase tracking-widest">{label}</label>
      <input 
        type={type}
        className="w-full bg-bg border-2 border-border rounded-2xl p-4 text-xl font-bold outline-none focus:border-accent"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: any) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-1 transition-all flex-1 py-1 ${active ? 'text-accent' : 'text-text-muted hover:text-accent/60'}`}
    >
      <div className="p-1 px-2 rounded-2xl transition-all">
        {React.cloneElement(icon as React.ReactElement, { size: 22, className: 'sm:w-6 sm:h-6' })}
      </div>
      <span className={`text-[9px] font-bold uppercase tracking-tighter ${active ? 'opacity-100' : 'opacity-60'}`}>{label}</span>
    </button>
  );
}

function NotesSection({ search, setSearch, notes, categories, highlightText, onAdd, onEdit, onDelete, t }: any) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const filtered = notes.filter((n: any) => {
    const matchesSearch = (n.title + n.body).toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !selectedCategory || n.categoryId === selectedCategory;
    return matchesSearch && matchesCategory;
  }).sort((a: any, b: any) => (a.title || "").localeCompare(b.title || ""));

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="space-y-4 sm:space-y-6">
        <div className="relative">
          <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" />
          <input 
            className="w-full bg-surface border border-border rounded-2xl py-4 pl-14 pr-6 outline-none focus:ring-2 focus:ring-accent/20 font-medium text-base transition-all placeholder:text-text-muted/60"
            placeholder={t('search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

      <div className="flex gap-2 overflow-x-auto pb-4 scrollbar-none px-1">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-6 py-2.5 rounded-full font-bold text-xs uppercase tracking-widest whitespace-nowrap transition-all border ${!selectedCategory ? 'bg-accent text-white border-accent shadow-lg shadow-accent/20' : 'bg-surface border-border text-text-muted'}`}
          >
            {t('all')}
          </button>
          {categories.map((cat: any) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-6 py-2.5 rounded-full font-bold text-xs uppercase tracking-widest whitespace-nowrap transition-all border ${selectedCategory === cat.id ? 'bg-accent text-white border-accent shadow-lg shadow-accent/20' : 'bg-surface border-border text-text-muted'}`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between px-1 mt-2">
        <h2 className="text-xl font-bold">{t('notes')}</h2>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 sm:py-32 space-y-4">
          <div className="w-20 h-20 sm:w-24 sm:h-24 bg-surface border-2 border-border rounded-full flex items-center justify-center mx-auto opacity-30">
            <Search size={32} className="sm:w-10 sm:h-10" />
          </div>
          <p className="text-lg sm:text-xl font-black text-text-muted uppercase tracking-widest">{t('none')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <AnimatePresence mode="popLayout">
            {filtered.map((note: any) => (
              <motion.div 
                layout key={note.id}
                initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                onClick={() => onEdit(note)}
                className="bg-card border border-border p-5 rounded-2xl hover:shadow-md active:scale-[0.98] transition-all cursor-pointer relative group overflow-hidden"
              >
                {/* Accent Stripe */}
                <div 
                  className="absolute left-0 top-0 bottom-0 w-1.5"
                  style={{ backgroundColor: note.categoryId ? categories.find((c: any) => c.id === note.categoryId)?.color || '#10b981' : '#10b981' }}
                />

                <div className="absolute top-4 right-4 text-text-muted">
                  <MoreVertical size={18} />
                </div>
                
                <h3 className="text-lg font-bold mb-2 truncate pr-6">{highlightText(note.title || t('untitled'), search)}</h3>
                <p className="text-text-muted line-clamp-2 text-sm leading-relaxed mb-6 opacity-80">
                  {highlightText(note.body, search)}
                </p>
                
                <div className="flex justify-between items-center text-[10px] sm:text-xs">
                  <div className="flex items-center gap-1.5 text-text-muted font-medium">
                    <Calendar size={12} className="text-accent" />
                    <span>{new Date(note.updatedAt).toLocaleDateString(t('locale'), { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                  </div>

                  {note.categoryId && (
                    <div className="bg-accent/10 text-accent px-2 py-1 rounded-md font-bold uppercase tracking-wider text-[10px]">
                      {categories.find((c: any) => c.id === note.categoryId)?.name}
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <motion.button 
        whileTap={{ scale: 0.9 }}
        whileHover={{ scale: 1.05 }}
        onClick={onAdd}
        className="fixed bottom-24 right-6 w-16 h-16 bg-accent rounded-2xl shadow-xl shadow-accent/30 flex items-center justify-center text-white z-40"
      >
        <Plus size={32} strokeWidth={3} />
      </motion.button>
    </div>
  );
}

function RemindersSection({ reminders, onAdd, onToggle, onDelete, onEdit, t }: any) {
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between mb-1 sm:mb-2 text-xs sm:text-sm font-black text-text-muted uppercase tracking-wider">
        <span>{reminders.length} {t('reminders')}</span>
      </div>

      {reminders.length === 0 ? (
        <div className="text-center py-24 sm:py-32 space-y-4">
          <div className="w-20 h-20 sm:w-24 sm:h-24 bg-surface border-2 border-border rounded-full flex items-center justify-center mx-auto opacity-30">
            <Bell size={32} className="sm:w-10 sm:h-10" />
          </div>
          <p className="text-lg sm:text-xl font-black text-text-muted uppercase tracking-widest">{t('none')}</p>
          <button onClick={onAdd} className="text-accent font-black underline">{t('addAlarm')}</button>
        </div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          <AnimatePresence mode="popLayout">
            {reminders.map((rem: any) => {
              const isOverdue = !rem.completed && new Date(`${rem.date || new Date().toISOString().split('T')[0]}T${rem.time}`) < new Date();
              return (
                <motion.div 
                  layout key={rem.id}
                  initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
                  className="bg-card border-2 border-border p-4 sm:p-6 rounded-[28px] sm:rounded-[32px] flex items-center justify-between gap-3 sm:gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <h3 className={`text-lg sm:text-xl font-black mb-1 truncate ${rem.completed ? 'line-through opacity-40' : ''}`}>{rem.title}</h3>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[10px] sm:text-sm font-black uppercase">
                      <div className="flex items-center gap-1.5 text-text-muted">
                        <Clock size={12} className="sm:w-[14px] sm:h-[14px]" />
                        <span>{rem.time}</span>
                      </div>
                      {rem.isDaily ? (
                        <span className="bg-accent-soft text-accent px-1.5 py-0.5 rounded-md">{t('daily')}</span>
                      ) : (
                        <span className="text-text-muted">{rem.date}</span>
                      )}
                      {rem.alarmEnabled && !rem.completed && (
                        <span className="flex items-center gap-1 text-orange-500 bg-orange-500/10 px-1.5 py-0.5 rounded-md">
                          <AlertCircle size={12} />
                          {t('alarm')}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2 sm:gap-3">
                    <button 
                      onClick={() => onEdit(rem)}
                      className="p-2 sm:p-3 text-accent hover:bg-accent/10 rounded-xl"
                    >
                      <Edit3 size={20} className="sm:w-6 sm:h-6" />
                    </button>
                    <button 
                      onClick={() => onToggle(rem.id)}
                      className={`w-11 h-11 sm:w-14 sm:h-14 rounded-xl sm:rounded-2xl flex items-center justify-center transition-all ${rem.completed ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}
                    >
                      {rem.completed ? <CheckCircle size={22} className="sm:w-7 sm:h-7" /> : <AlertTriangle size={22} className="sm:w-7 sm:h-7" />}
                    </button>
                    <button onClick={() => onDelete(rem.id)} className="p-2 sm:p-3 text-red-500 hover:bg-red-500/10 rounded-xl">
                      <Trash2 size={20} className="sm:w-6 sm:h-6" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <motion.button 
        whileTap={{ scale: 0.9 }}
        onClick={onAdd}
        className="fixed bottom-24 sm:bottom-28 right-6 sm:right-8 w-16 h-16 sm:w-20 sm:h-20 bg-green-500 rounded-[28px] sm:rounded-[32px] shadow-2xl flex items-center justify-center text-white z-40"
      >
        <Plus size={32} className="sm:w-10 sm:h-10" />
      </motion.button>
    </div>
  );
}

function PasswordsSection({ passwords, onAdd, onDelete, onEdit, onCopy, t }: any) {
  const [showPass, setShowPass] = useState<string | null>(null);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between mb-1 sm:mb-2">
        <p className="text-[10px] sm:text-sm font-black text-text-muted uppercase tracking-wider">{passwords.length} {t('passwords')}</p>
      </div>

      {passwords.length === 0 ? (
        <div className="text-center py-24 sm:py-32 space-y-4">
          <div className="w-20 h-20 sm:w-24 sm:h-24 bg-surface border-2 border-border rounded-full flex items-center justify-center mx-auto opacity-30">
            <Shield size={32} className="sm:w-10 sm:h-10" />
          </div>
          <p className="text-lg sm:text-xl font-black text-text-muted uppercase tracking-widest">{t('none')}</p>
          <button onClick={onAdd} className="text-accent font-black underline">{t('newNote')}</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <AnimatePresence mode="popLayout">
            {passwords.map((pass: any) => (
              <motion.div 
                layout key={pass.id}
                initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                className="bg-card border-2 border-border p-5 sm:p-6 rounded-[28px] sm:rounded-[32px] space-y-3 sm:space-y-4"
              >
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg sm:text-xl font-black truncate">{pass.title}</h3>
                    <p className="text-text-muted font-bold text-xs sm:text-sm tracking-tight truncate">{pass.username}</p>
                  </div>
                  <div className="flex gap-1.5 sm:gap-2 ml-2">
                    <button onClick={() => onEdit(pass)} className="p-2 sm:p-3 bg-surface rounded-xl text-accent"><Edit3 size={18} className="sm:w-5 sm:h-5" /></button>
                    <button onClick={() => onDelete(pass.id)} className="p-2 sm:p-3 bg-surface rounded-xl text-red-500"><Trash2 size={18} className="sm:w-5 sm:h-5" /></button>
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:gap-3 p-3 sm:p-4 bg-bg rounded-2xl border-2 border-border relative overflow-hidden">
                  <div className="flex-1 font-mono font-bold text-base sm:text-lg truncate">
                    {showPass === pass.id ? pass.password : '••••••••••••'}
                  </div>
                  <div className="flex gap-1 sm:gap-2">
                    <button onClick={() => setShowPass(showPass === pass.id ? null : pass.id)} className="p-1.5 text-text-muted hover:text-accent transition-colors">
                      {showPass === pass.id ? <EyeOff size={20} className="sm:w-6 sm:h-6" /> : <Eye size={20} className="sm:w-6 sm:h-6" />}
                    </button>
                    <button onClick={() => onCopy(pass.password)} className="p-1.5 text-text-muted hover:text-accent transition-colors">
                      <Copy size={20} className="sm:w-6 sm:h-6" />
                    </button>
                  </div>
                </div>

                {pass.url && (
                  <div className="flex items-center gap-2 text-[10px] sm:text-sm font-bold text-accent">
                    <Globe size={12} className="sm:w-[14px] sm:h-[14px]" />
                    <span className="truncate">{pass.url}</span>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <motion.button 
        whileTap={{ scale: 0.9 }}
        onClick={onAdd}
        className="fixed bottom-24 sm:bottom-28 right-6 sm:right-8 w-16 h-16 sm:w-20 sm:h-20 bg-orange-500 rounded-[28px] sm:rounded-[32px] shadow-2xl flex items-center justify-center text-white z-40"
      >
        <Plus size={32} className="sm:w-10 sm:h-10" />
      </motion.button>
    </div>
  );
}

function SettingsSection({ notes, categories, setCategories, saveData, pin, isBackingUp, showBackupMethods, setShowBackupMethods, shareBackup, handleFilesystemRestore, fileInputRef, handleRestore, theme, setTheme, t, language, setLanguage, startChangePin, elderlyMode, setElderlyMode, tryBiometricUnlock }: any) {
  const [newCatName, setNewCatName] = useState('');

  const addCategory = () => {
    if (!newCatName.trim()) return;
    const colors = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#8b5cf6'];
    const newCat = {
      id: Date.now().toString(),
      name: newCatName.trim(),
      color: colors[categories.length % colors.length]
    };
    const updated = [...categories, newCat];
    setCategories(updated);
    saveData('categories', updated, pin);
    setNewCatName('');
  };

  const deleteCategory = (id: string) => {
    if (confirm(t('deleteConfirm'))) {
      const updated = categories.filter((c: any) => c.id !== id);
      setCategories(updated);
      saveData('categories', updated, pin);
    }
  };

  const resetData = () => {
    if (confirm(t('restoreConfirm'))) {
      const p = prompt(`${t('confirmDelete')}?`);
      if (p && p.toUpperCase() === t('confirmDelete')) {
        localStorage.clear();
        window.location.reload();
      }
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 pb-20">
      {/* V2 Security & Accessibility */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-4">
        <div>
          <h3 className="text-lg sm:text-xl font-black mb-1">V2 Güvenlik ve Kullanım</h3>
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">MakroSOFT Secure Notes</p>
        </div>
        <button onClick={tryBiometricUnlock} className="w-full flex items-center justify-between p-4 bg-surface border border-border rounded-2xl font-black">
          <span className="flex items-center gap-3"><Fingerprint size={22}/> Parmak izi / Face ID hazırlığı</span>
          <span className="text-xs text-accent">V2</span>
        </button>
        <button onClick={() => setElderlyMode(!elderlyMode)} className="w-full flex items-center justify-between p-4 bg-surface border border-border rounded-2xl font-black">
          <span className="flex items-center gap-3"><Accessibility size={22}/> Yaşlı kullanıcı modu</span>
          <span className={elderlyMode ? 'text-green-500' : 'text-text-muted'}>{elderlyMode ? 'Açık' : 'Kapalı'}</span>
        </button>
        <div className="p-4 bg-amber-500/10 text-amber-600 rounded-2xl text-sm font-bold flex gap-3">
          <ShieldAlert size={22} className="shrink-0"/>
          <span>Clipboard şifre kopyalandıktan 30 saniye sonra otomatik temizlenir. Native bildirim ve gerçek biyometrik giriş APK derleme aşamasında plugin ile aktif edilir.</span>
        </div>
      </div>

      {/* Category Management */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-4 sm:space-y-6">
        <div>
          <h3 className="text-lg sm:text-xl font-black mb-1">{t('categories')}</h3>
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">{t('notes')}</p>
        </div>

        <div className="space-y-3">
          {categories.map((cat: any) => (
            <div key={cat.id} className="flex items-center justify-between p-4 bg-surface border border-border rounded-2xl group shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-lg" style={{ backgroundColor: cat.color }} />
                <span className="font-bold text-sm sm:text-base">{cat.name}</span>
              </div>
              <button 
                onClick={() => deleteCategory(cat.id)}
                className="p-2 text-text-muted hover:text-red-500 transition-all active:scale-90"
              >
                <Trash2 size={20} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <input 
            className="flex-1 bg-bg border-2 border-border rounded-2xl px-5 py-4 text-sm font-bold outline-none focus:border-accent"
            placeholder={t('newCategoryName')}
            value={newCatName}
            onChange={e => setNewCatName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCategory()}
          />
          <button 
            onClick={addCategory}
            className="bg-accent text-white font-black px-8 py-4 rounded-2xl text-base transition-all active:scale-95 shadow-lg shadow-accent/20"
          >
            {t('addCategory')}
          </button>
        </div>
      </div>

      {/* Language Section */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-4 sm:space-y-6">
        <div>
          <h3 className="text-lg sm:text-xl font-black mb-1">{t('language')}</h3>
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">{t('language')}</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
          {[
            { id: 'tr', label: 'Türkçe', flag: '🇹🇷' },
            { id: 'en', label: 'English', flag: '🇺🇸' },
            { id: 'de', label: 'Deutsch', flag: '🇩🇪' },
            { id: 'es', label: 'Español', flag: '🇪🇸' },
            { id: 'fr', label: 'Français', flag: '🇫🇷' },
            { id: 'ku', label: 'Kurdî', flag: '☀️' }
          ].map((lang) => (
            <button 
              key={lang.id}
              onClick={() => setLanguage(lang.id as Language)}
              className={`flex items-center justify-center gap-2 p-3 sm:p-4 rounded-2xl border-2 transition-all ${language === lang.id ? 'border-accent bg-accent-soft text-accent' : 'border-border text-text-muted hover:border-accent/40'}`}
            >
              <span className="text-base sm:text-lg">{lang.flag}</span>
              <span className="text-xs sm:text-sm font-black uppercase tracking-tight">{lang.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Appearance Section */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-4 sm:space-y-6">
        <div>
          <h3 className="text-lg sm:text-xl font-black mb-1">{t('theme')}</h3>
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">{t('theme')}</p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <button 
            onClick={() => setTheme('light')}
            className={`flex flex-col items-center gap-2 sm:gap-3 p-4 sm:p-6 rounded-3xl border-2 transition-all ${theme === 'light' ? 'border-accent bg-accent-soft' : 'border-border'}`}
          >
            <Sun className={`${theme === 'light' ? 'text-accent' : 'text-text-muted'} w-7 h-7 sm:w-8 sm:h-8`} />
            <span className={`text-sm sm:text-base font-bold ${theme === 'light' ? 'text-accent' : 'text-text-muted'}`}>{t('light')}</span>
          </button>
          <button 
            onClick={() => setTheme('dark')}
            className={`flex flex-col items-center gap-2 sm:gap-3 p-4 sm:p-6 rounded-3xl border-2 transition-all ${theme === 'dark' ? 'border-accent bg-accent-soft' : 'border-border'}`}
          >
            <Moon className={`${theme === 'dark' ? 'text-accent' : 'text-text-muted'} w-7 h-7 sm:w-8 sm:h-8`} />
            <span className={`text-sm sm:text-base font-bold ${theme === 'dark' ? 'text-accent' : 'text-text-muted'}`}>{t('dark')}</span>
          </button>
        </div>
      </div>

      {/* Security Section */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-4 sm:space-y-6">
        <div>
          <h3 className="text-lg sm:text-xl font-black mb-1">{t('security')}</h3>
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">{t('security')}</p>
        </div>

        <button 
          onClick={startChangePin}
          className="w-full flex items-center justify-between p-5 sm:p-6 bg-surface border-2 border-border text-text-main rounded-3xl font-black text-lg sm:text-xl active:scale-95 transition-all"
        >
          <div className="flex items-center gap-3 sm:gap-4">
            <Key size={24} className="sm:w-8 sm:h-8 text-accent" />
            <span>{t('changePin')}</span>
          </div>
          <ChevronRight size={20} className="text-text-muted sm:w-6 sm:h-6" />
        </button>
      </div>

      {/* Data Backup */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-6 sm:space-y-8">
        <div>
          <h3 className="text-lg sm:text-xl font-black mb-1">{t('dataManagement')}</h3>
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">{t('backupAndRestore')}</p>
        </div>

        <div className="space-y-3 sm:space-y-4">
          <button 
            onClick={shareBackup}
            disabled={isBackingUp}
            className="w-full flex items-center justify-between p-5 sm:p-6 bg-accent text-white rounded-3xl font-black text-lg sm:text-xl shadow-lg shadow-accent/20 active:scale-95 transition-all disabled:opacity-50"
          >
            <div className="flex items-center gap-3 sm:gap-4">
              <Share2 size={24} className="sm:w-8 sm:h-8" />
              <span>{t('backup')}</span>
            </div>
            {isBackingUp ? <RefreshCw className="animate-spin" /> : <ChevronRight />}
          </button>

          <button 
            onClick={handleFilesystemRestore}
            className="w-full flex items-center justify-between p-5 sm:p-6 bg-surface border-2 border-border text-text-main rounded-3xl font-black text-lg sm:text-xl active:scale-95 transition-all"
          >
            <div className="flex items-center gap-3 sm:gap-4">
              <Upload size={24} className="sm:w-8 sm:h-8 text-text-muted" />
              <span>{t('restore')}</span>
            </div>
            <ChevronRight size={20} className="text-text-muted sm:w-6 sm:h-6" />
          </button>
        </div>
      </div>

      {/* About & Info */}
      <div className="bg-card border-2 border-border p-6 sm:p-8 rounded-[32px] sm:rounded-[40px] space-y-4 sm:space-y-6">
        <div className="flex justify-center py-2">
          <p className="text-[10px] sm:text-sm text-text-muted font-bold uppercase tracking-widest">Makrosoft.NET</p>
        </div>

        <button 
          onClick={resetData}
          className="w-full py-3 sm:py-4 text-red-500 font-black text-[10px] sm:text-sm uppercase tracking-widest hover:bg-red-500/10 rounded-2xl transition-colors"
        >
          {t('resetData')}
        </button>

        <input type="file" ref={fileInputRef} onChange={handleRestore} className="hidden" accept=".json" />
      </div>
    </div>
  );
}

function PinScreen({ step, onDone, title, subtitle, t }: { step: number, onDone: (p: string) => void, title: string, subtitle: string, t: any }) {
  const [val, setVal] = useState('');
  
  const handleKey = (k: string) => {
    if (val.length >= 6) return;
    const n = val + k;
    setVal(n);
    if (n.length === 6) {
      setTimeout(() => {
        onDone(n);
        setVal('');
      }, 300);
    }
  };

  const handleDel = () => setVal(v => v.slice(0, -1));

  const rows = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', '⌫']
  ];

  return (
    <div className="h-screen bg-bg flex flex-col items-center justify-center p-4 sm:p-6 text-center overflow-hidden">
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8 sm:mb-12"
      >
        <div className="text-2xl sm:text-3xl mb-3 sm:mb-4">🔐</div>
        <h2 className="text-lg sm:text-xl font-bold text-text-main mb-1 uppercase tracking-tight">{title}</h2>
        <p className="text-text-muted text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.2em]">{subtitle}</p>
      </motion.div>

      <div className="flex gap-2 sm:gap-3 mb-8 sm:mb-10 mt-2 sm:mt-4">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <motion.div 
            key={i}
            animate={{ 
              backgroundColor: val.length > i ? '#a855f7' : 'transparent',
              scale: val.length > i ? 1.1 : 1,
              borderColor: val.length > i ? '#a855f7' : '#94a3b8'
            }}
            className="w-3 h-3 sm:w-4 sm:h-4 rounded-full border-2 transition-all"
          />
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:gap-3">
        {rows.map((row, ri) => (
          <div key={ri} className="flex gap-3 sm:gap-4 justify-center">
            {row.map((k, ki) => {
              if (k === '') {
                return <div key={ki} className="w-[72px] sm:w-[82px]" />;
              }
              return (
                <motion.button
                  key={ki}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => k === '⌫' ? handleDel() : handleKey(k)}
                  className="w-[72px] h-[72px] sm:w-[82px] sm:h-[82px] rounded-full bg-surface border border-border flex items-center justify-center group shadow-sm active:bg-accent/10"
                >
                  <span className={`text-xl sm:text-2xl font-semibold ${k === '⌫' ? 'text-red-500' : 'text-text-main'}`}>
                    {k}
                  </span>
                </motion.button>
              );
            })}
          </div>
        ))}
      </div>

      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="mt-12 text-[10px] text-text-muted font-bold tracking-[0.2em] uppercase opacity-40 hover:opacity-100 transition-opacity cursor-default"
      >
        Makrosoft.NET
      </motion.div>
    </div>
  );
}

// Custom styles for shadow glow
const style = document.createElement('style');
style.textContent = `
  .shadow-glow { box-shadow: 0 0 30px rgba(108, 99, 255, 0.2); }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .animate-spin { animation: spin 1s linear infinite; }
`;
document.head.append(style);
