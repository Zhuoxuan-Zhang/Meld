import type { MarketApp } from "./market";
export type Feature = {
  id: string;
  name: string;
  description: string;
  icon: string;
  recommended?: boolean;
  flow: string;
  // From a completed summary of the app's store listing.
  listed?: boolean;
};
export type ReferenceApp = {
  id: string;
  name: string;
  domain: string;
  tagline: string;
  description: string;
  icon: string;
  color: string;
  bg: string;
  label: string;
  features: Feature[];
  // Present for apps that came from a live market scan.
  market?: MarketApp;
  // Other chosen domains whose scans also ranked this app.
  alsoIn?: string[];
};
export const domains = [
  { name: "Notes & lists", icon: "NotebookPen", description: "Small notebooks, checklists and to-do apps", color: "#a85038", bg: "#f8e8df" },
  { name: "Focus & habits", icon: "Timer", description: "Timers, daily check-ins and simple progress", color: "#53745d", bg: "#e9eee4" },
  { name: "Journals & diaries", icon: "Smile", description: "Private entries, moods and a daily history", color: "#816d97", bg: "#eee8f3" },
  { name: "Flashcards", icon: "Layers", description: "Make your own cards and practice offline", color: "#826342", bg: "#f4eddd" },
  { name: "Reading lists", icon: "BookOpen", description: "Track books, reading status and progress", color: "#536f87", bg: "#e7edf2" },
  { name: "Counters & tallies", icon: "CirclePlus", description: "Tap to count, set targets and save totals", color: "#927048", bg: "#f5ebdd" },
  {
    name: "Productivity",
    icon: "Sparkles",
    description: "Make room for your best work",
    color: "#a85038",
    bg: "#f8e8df",
  },
  {
    name: "Wellness",
    icon: "Flower2",
    description: "A little more peace of mind",
    color: "#53745d",
    bg: "#e9eee4",
  },
  {
    name: "Learning",
    icon: "BookOpen",
    description: "Stay curious. Keep growing.",
    color: "#826342",
    bg: "#f4eddd",
  },
  {
    name: "Finance",
    icon: "Wallet",
    description: "Feel good about your money",
    color: "#536f87",
    bg: "#e7edf2",
  },
  {
    name: "Fitness",
    icon: "Activity",
    description: "Build a rhythm that lasts",
    color: "#927048",
    bg: "#f5ebdd",
  },
  {
    name: "Creativity",
    icon: "Palette",
    description: "Give your ideas a place to go",
    color: "#816d97",
    bg: "#eee8f3",
  },
];
const f = (
  id: string,
  name: string,
  description: string,
  icon: string,
  flow: string,
  recommended = true,
): Feature => ({ id, name, description, icon, flow, recommended });
const features = {
  timer: f(
    "timer",
    "Focus timer",
    "Make space for deep work with a simple, pausable focus session.",
    "Timer",
    "Choose a duration, start a session, then pause or reset it.",
  ),
  garden: f(
    "garden",
    "Your focus garden",
    "Turn completed focus sessions into a small collection of growing plants.",
    "TreePine",
    "Complete a focus session or log one, then watch your garden grow.",
  ),
  tasks: f(
    "tasks",
    "Simple task lists",
    "Keep your next steps close, and enjoy checking them off.",
    "ListTodo",
    "Add a task, mark it complete, or remove it.",
  ),
  insights: f(
    "insights",
    "Progress at a glance",
    "See a simple overview of what you have completed in your app.",
    "ChartNoAxesColumnIncreasing",
    "Complete activities and see the progress summary update.",
  ),
  notes: f(
    "notes",
    "Quick notes",
    "Capture thoughts in a clean, distraction-free space.",
    "NotebookPen",
    "Write a note, save it, then edit or delete it.",
  ),
  habits: f(
    "habits",
    "Daily habit check-ins",
    "Build a steady routine with small actions you can check off each day.",
    "CircleCheck",
    "Create a habit and toggle today’s check-in.",
  ),
  breathing: f(
    "breathing",
    "Guided breathing",
    "Take a quiet moment with a visual breathing exercise.",
    "Wind",
    "Start a breathing cycle, follow the visual guide, then stop.",
  ),
  journal: f(
    "journal",
    "Mood journal",
    "Notice how you feel and give your day a little context.",
    "Smile",
    "Choose a mood, write a reflection, and save your entry.",
  ),
  workouts: f(
    "workouts",
    "Workout log",
    "Record your movement and keep a personal activity history.",
    "Dumbbell",
    "Name an activity, enter its duration, and save it.",
  ),
  goals: f(
    "goals",
    "Personal goals",
    "Break a bigger ambition into progress you can see.",
    "Flag",
    "Create a goal with a target and add progress toward it.",
  ),
  flashcards: f(
    "flashcards",
    "Practice flashcards",
    "Turn something new into something you remember.",
    "Layers",
    "Add a question and answer, flip the card, then move to the next.",
  ),
  reading: f(
    "reading",
    "Reading list",
    "Keep the articles and books you want to come back to.",
    "BookOpen",
    "Add a title and optional link, then mark it as read.",
  ),
  budget: f(
    "budget",
    "Monthly budget",
    "Set a spending limit and see how much room you have left.",
    "Wallet",
    "Set a budget, record expenses, and review the remaining balance.",
  ),
  expenses: f(
    "expenses",
    "Expense tracking",
    "Make everyday spending a little easier to understand.",
    "Receipt",
    "Add an expense with a description and amount, then review or delete it.",
  ),
  boards: f(
    "boards",
    "Idea boards",
    "Collect loose ideas and move them from possibility to progress.",
    "LayoutDashboard",
    "Add an idea and move it between To explore, In progress, and Done.",
  ),
  bookmarks: f(
    "bookmarks",
    "Saved inspiration",
    "Keep useful links and little discoveries in one place.",
    "Bookmark",
    "Save a title and web link, then open or remove it.",
  ),
};
export const featureById = features as Record<string, Feature>;
// Free text stays as typed (whitespace tidied); only a suggested domain's own
// name, in any case, becomes that suggested domain.
export function canonicalDomain(value: string) {
  const clean = value.trim().replace(/\s+/g, " ");
  return (
    domains.find((d) => d.name.toLowerCase() === clean.toLowerCase())?.name ||
    clean
  );
}
