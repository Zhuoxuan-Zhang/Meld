import type { MarketApp } from "./market";
export type Feature = {
  id: string;
  name: string;
  description: string;
  icon: string;
  recommended?: boolean;
  flow: string;
  // From the app's store listing (summarized by Claude Code), not one of the
  // built-in features the browser demo can build.
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
export const apps: ReferenceApp[] = [
  {
    id: "forest",
    name: "Forest",
    domain: "Productivity",
    tagline: "Find your focus. Grow something good.",
    description:
      "A calmer approach to getting things done, built around focused time and a little daily encouragement.",
    icon: "TreePine",
    color: "#456b44",
    bg: "#e9efdf",
    label: "A calmer kind of focus",
    features: [features.timer, features.garden, features.insights],
  },
  {
    id: "ticktick",
    name: "TickTick",
    domain: "Productivity",
    tagline: "A little order for your everyday.",
    description:
      "Tasks, habits, and focused time come together in one practical daily workspace.",
    icon: "CheckCheck",
    color: "#466383",
    bg: "#e9eef6",
    label: "A place for your plans",
    features: [
      features.tasks,
      features.timer,
      features.habits,
      features.insights,
    ],
  },
  {
    id: "notion",
    name: "Notion",
    domain: "Productivity",
    tagline: "A home for ideas, big and small.",
    description:
      "A flexible workspace for notes, to-dos, and all the ideas that do not fit neatly into a box.",
    icon: "NotebookPen",
    color: "#414541",
    bg: "#ecece7",
    label: "Room to think",
    features: [
      features.notes,
      features.tasks,
      features.boards,
      features.bookmarks,
    ],
  },
  {
    id: "headspace",
    name: "Headspace",
    domain: "Wellness",
    tagline: "A softer start to your day.",
    description:
      "Small moments of mindfulness, with gentle prompts to pause and check in with yourself.",
    icon: "Sun",
    color: "#984720",
    bg: "#f8e7d9",
    label: "Find a little headspace",
    features: [features.breathing, features.habits, features.journal],
  },
  {
    id: "calm",
    name: "Calm",
    domain: "Wellness",
    tagline: "Take a breath. Make some space.",
    description:
      "A quiet space for breathing exercises and intentional moments away from the busy parts of life.",
    icon: "Waves",
    color: "#466175",
    bg: "#e5edf2",
    label: "Less rush, more room",
    features: [features.breathing, features.timer, features.journal],
  },
  {
    id: "daylio",
    name: "Daylio",
    domain: "Wellness",
    tagline: "Get to know your days.",
    description:
      "Simple mood check-ins and habits that help you reflect on your own rhythm.",
    icon: "Smile",
    color: "#795481",
    bg: "#f0e6f0",
    label: "Small check-ins matter",
    features: [features.journal, features.habits, features.insights],
  },
  {
    id: "duolingo",
    name: "Duolingo",
    domain: "Learning",
    tagline: "A little learning, every day.",
    description:
      "Bite-sized practice and daily routines that make learning feel approachable.",
    icon: "Bird",
    color: "#506d2b",
    bg: "#edf2df",
    label: "Keep your curiosity going",
    features: [features.flashcards, features.habits, features.goals],
  },
  {
    id: "anki",
    name: "Anki",
    domain: "Learning",
    tagline: "Make it stick.",
    description:
      "A focused flashcard experience for practicing the things you want to remember.",
    icon: "Layers",
    color: "#496987",
    bg: "#e7eff6",
    label: "Your next lightbulb moment",
    features: [features.flashcards, features.timer, features.insights],
  },
  {
    id: "readwise",
    name: "Readwise",
    domain: "Learning",
    tagline: "Keep the good ideas close.",
    description:
      "A home for reading, personal notes, and the discoveries worth remembering.",
    icon: "BookOpen",
    color: "#886024",
    bg: "#f5ecdb",
    label: "Read. Remember. Return.",
    features: [features.reading, features.notes, features.bookmarks],
  },
  {
    id: "ynab",
    name: "YNAB",
    domain: "Finance",
    tagline: "Give your money a little direction.",
    description:
      "A considered approach to spending and saving, with a plan you can actually see.",
    icon: "Wallet",
    color: "#3e6079",
    bg: "#e5eef5",
    label: "A plan for every day",
    features: [features.budget, features.expenses, features.goals],
  },
  {
    id: "spendee",
    name: "Spendee",
    domain: "Finance",
    tagline: "A clearer picture of your spending.",
    description:
      "Simple expense records and an at-a-glance budget for everyday money decisions.",
    icon: "ChartPie",
    color: "#386c5b",
    bg: "#e3eee7",
    label: "Make money feel simpler",
    features: [features.expenses, features.budget, features.insights],
  },
  {
    id: "moneylover",
    name: "Money Lover",
    domain: "Finance",
    tagline: "Small steps toward bigger plans.",
    description:
      "Keep track of expenses and make steady progress toward a savings goal.",
    icon: "PiggyBank",
    color: "#577737",
    bg: "#eaf0df",
    label: "Build your next chapter",
    features: [features.expenses, features.goals, features.notes],
  },
  {
    id: "strava",
    name: "Strava",
    domain: "Fitness",
    tagline: "Make your next move.",
    description:
      "A place to record your activity and build a steady rhythm of movement.",
    icon: "Activity",
    color: "#a24c2a",
    bg: "#faeadd",
    label: "Every little move counts",
    features: [features.workouts, features.goals, features.insights],
  },
  {
    id: "strong",
    name: "Strong",
    domain: "Fitness",
    tagline: "Show up. Get a little stronger.",
    description:
      "A straightforward workout log for keeping track of your effort and progress.",
    icon: "Dumbbell",
    color: "#456788",
    bg: "#e6eef6",
    label: "Progress at your own pace",
    features: [features.workouts, features.timer, features.notes],
  },
  {
    id: "habitica",
    name: "Habitica",
    domain: "Fitness",
    tagline: "Make a habit of showing up.",
    description:
      "Daily habits, small goals, and checkable tasks give your routine a little momentum.",
    icon: "Swords",
    color: "#735a8a",
    bg: "#eee8f5",
    label: "Make everyday a small win",
    features: [features.habits, features.tasks, features.goals],
  },
  {
    id: "pinterest",
    name: "Pinterest",
    domain: "Creativity",
    tagline: "Follow a little inspiration.",
    description:
      "Gather the ideas and links that catch your eye, then give them a place to grow.",
    icon: "Pin",
    color: "#9d4442",
    bg: "#f8e7e5",
    label: "Start with a spark",
    features: [features.bookmarks, features.boards, features.notes],
  },
  {
    id: "milanote",
    name: "Milanote",
    domain: "Creativity",
    tagline: "Make room for messy ideas.",
    description:
      "Collect notes and inspiration, then arrange them into a plan that feels like you.",
    icon: "LayoutDashboard",
    color: "#7d6027",
    bg: "#f6edda",
    label: "Your ideas, taking shape",
    features: [features.boards, features.notes, features.tasks],
  },
  {
    id: "dayone",
    name: "Day One",
    domain: "Creativity",
    tagline: "Give your days a few words.",
    description:
      "A thoughtful place for personal reflections, everyday observations, and new ideas.",
    icon: "NotebookPen",
    color: "#357287",
    bg: "#e3f0f3",
    label: "A page of your own",
    features: [features.journal, features.notes, features.habits],
  },
];
export const appById = Object.fromEntries(apps.map((a) => [a.id, a]));
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
