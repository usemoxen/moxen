use crate::{
    attachments::{self, Asset, Prompt},
    catalog::{Catalog, prettify, provider_color},
    composer::{Composer, Pasted, Queued, Submitted},
    composer_menu::{self, Destination, Improvement},
    live::ServerSource,
    mock::MockSource,
    model::{
        CatalogState, Delivery, Discovery, INTERACTION_MODES, NewThread, PickerState, QueueEdit,
        RUNTIME_MODES, Reply, ResearchRole, Selection, Status, ThreadId, ThreadSource,
    },
    theme::{self, color},
    thread_actions,
};
use gpui::{prelude::*, *};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::{Duration, Instant},
};

/// The turn keeps at least this width; the inspector gives way first.
const MIN_TURN: f32 = 480.;
const MIN_INSPECTOR: f32 = 320.;
/// The sidebar row tip's height: one 16px line in 5px of vertical padding.
const THREAD_TIP_HEIGHT: f32 = 26.;

/// The menu open over the composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dropdown {
    Project,
    Access,
    Mode,
    Thread,
    Attach,
}

/// Focus handles for toolbar controls that show a tip under keyboard focus.
pub struct Tips {
    pub jump: FocusHandle,
    pub tasks: FocusHandle,
    pub inspector: FocusHandle,
    pub stop: FocusHandle,
    pub send: FocusHandle,
}

pub struct Workspace {
    pub source: Box<dyn ThreadSource>,
    pub selected: ThreadId,
    /// Set once a thread has been picked by default, so a later snapshot does not move the selection.
    chosen: bool,
    pub sidebar_focus: FocusHandle,
    pub composers: Vec<Entity<Composer>>,
    /// Drafting a thread: the transcript and the thread's composer give way to
    /// the new-thread composer and its choices.
    pub creating: bool,
    pub new_composer: Entity<Composer>,
    new_sending: bool,
    pub improving: bool,
    pub viewer: Option<crate::image_view::Viewer>,
    pub viewer_focus: FocusHandle,
    /// The project a new thread starts in (a project id), until one is picked.
    pub new_project: Option<String>,
    pub new_scratch: bool,
    /// The access chosen for the new thread; none leaves it to the server.
    pub new_runtime: Option<usize>,
    pub new_interaction: usize,
    /// The model chosen for the new thread; none starts it on its project's.
    pub new_model: Option<Selection>,
    pub dropdown: Option<Dropdown>,
    /// Takes keys while an approval or question is open in the composer's place.
    pub ask_focus: FocusHandle,
    /// The answers given to the open request.
    pub draft: crate::ask::Draft,
    /// The field for a written answer is open.
    pub custom_open: bool,
    pub custom_input: Entity<Composer>,
    /// The last thing that went wrong, until it is dismissed.
    pub problem: Option<String>,
    pub lists: Vec<ListState>,
    /// Opened steps, with when each opened (for the expand transition).
    pub expanded: HashMap<(ThreadId, usize), Instant>,
    pub inspector_open: bool,
    pub tasks_open: bool,
    pub picker_open: bool,
    pub palette_open: bool,
    pub model_focus: FocusHandle,
    pub group: usize,
    pub tab: usize,
    pub search: Entity<Composer>,
    pub thread_popup: Option<thread_actions::Popup>,
    pub thread_form: Option<thread_actions::Form>,
    pub project_popup: Option<thread_actions::ProjectPopup>,
    pub project_form: Option<thread_actions::ProjectForm>,
    pub action_model: Option<Selection>,
    pub action_input: Entity<Composer>,
    pub thread_action_focus: FocusHandle,
    focus_new_draft: bool,
    /// A notice above the composer, until it is dismissed. The parked
    /// run-size question clears itself, like the TUI's toast.
    pub notice: Option<String>,
    pub notice_at: Option<Instant>,
    /// The thread searched for, and when the palette's text last changed: the
    /// search goes out once the query holds still.
    searched: String,
    search_at: Option<(Instant, String)>,
    /// The connection the palette's query was last sent on: a reconnect
    /// re-issues it, so the palette never keeps a stale error or empty result.
    search_epoch: u64,
    /// The run-size proposal the window already focused, by thread: focusing
    /// once when it first appears (like the TUI focuses its picker), not on
    /// every redraw.
    pub proposal_seen: Option<(ThreadId, String)>,
    /// The threads the server may ask this window for a run size, last sent.
    research_watching: Option<ThreadId>,
    /// The lead thread opened in full: its transcript shows, not its run.
    pub lead_full: Option<ThreadId>,
    /// A role agent opened in full: its lead and its roster reference.
    pub role_full: Option<(ThreadId, ResearchRole, usize)>,
    /// The run view's columns: the role keys act on and the agent each role
    /// shows, by lead thread.
    pub run_role: HashMap<ThreadId, ResearchRole>,
    pub run_picks: HashMap<(ThreadId, ResearchRole), usize>,
    /// Role transcript tool rows opened in the run view, by lead, role,
    /// agent and step.
    pub run_expanded: HashSet<(ThreadId, ResearchRole, usize, usize)>,
    /// The run view's chip or column header the pointer is over, whose tip
    /// shows (`research_view::run_tip`).
    pub run_hover: Option<crate::research_view::RunHover>,
    /// The size picker's state, by thread: the proposal it answers and its state.
    pub picker: HashMap<ThreadId, (String, PickerState)>,
    /// Runs of steps the user flipped from their default (folded unless last), by thread and first step.
    pub fold_toggled: HashSet<(ThreadId, usize)>,
    pub unfolded_at: HashMap<(ThreadId, usize), Instant>,
    /// The transcript each thread's list was last sized for (live sources only).
    shown: HashMap<ThreadId, std::sync::Arc<Vec<crate::model::Message>>>,
    /// The thread the source was last told to follow.
    focused: Option<ThreadId>,
    pub picker_at: Option<Instant>,
    pub inspector_at: Option<Instant>,
    pub tips: Tips,
    pub settled_open: bool,
    /// The sidebar thread row the pointer hovers, with its window Y, when
    /// its title is truncated: the full title shows beside the row instead
    /// of a window tooltip over the rows below.
    pub thread_tip: Option<(ThreadId, f32)>,
    /// The listed rows the tip was taken against. The tip names a row by its
    /// window Y, so any change to this list (delete, collapse, regroup,
    /// reorder) moves the rows and drops the tip.
    pub(crate) thread_tip_order: Vec<ThreadId>,
    pub inspector_width: f32,
    pub resizing_inspector: bool,
    /// The Git and Diff tabs' own state.
    pub git_ui: crate::git_view::GitUi,
    pub work_ui: crate::work_view::WorkUi,
    pub work_focus: FocusHandle,
    /// The stats overlay: open, and the tab and range it shows.
    pub stats_open: bool,
    pub stats_tab: crate::stats::StatsTab,
    pub stats_range: crate::stats::StatsRange,
    /// The sidebar Stats row is hovered: its tip shows to the right of the
    /// row instead of a window tooltip over the label.
    pub stats_tip: bool,
    /// The settings window: open, on a tab, with a list entry, skill or
    /// memory open inside it, and a form, confirmation or add-flow below.
    pub settings_open: bool,
    pub settings_tab: (String, Option<String>),
    pub settings_editor: Option<String>,
    pub settings_price_model: Option<String>,
    pub settings_rail_tip: Option<usize>,
    pub settings_entry: Option<String>,
    pub settings_item: Option<String>,
    pub settings_skill: Option<(String, String)>,
    pub settings_memory: Option<(String, String)>,
    pub settings_form: Option<crate::settings_view::SettingsForm>,
    pub settings_form_saving: bool,
    pub settings_confirm: Option<(String, String, crate::settings_view::SettingsConfirm)>,
    pub settings_error: Option<String>,
    pub settings_notice: Option<(String, bool)>,
    pub settings_input: Entity<Composer>,
    pub settings_find: Entity<Composer>,
    pub settings_export: Option<(String, String)>,
    pub settings_discovered: Option<Discovery>,
    pub settings_memory_new: Option<crate::settings_view::MemoryWizard>,
    pub settings_profile_new: Option<crate::settings_view::ProfileWizard>,
    pub settings_mcp_new: Option<crate::settings_view::McpWizard>,
    pub settings_focus: FocusHandle,
    pub experience_ui: crate::experience::Ui,
    pub experience_focus: FocusHandle,
    pub guide_next_focus: FocusHandle,
    pub guide_folder: Entity<Composer>,
    pub guide_provider_filter: Entity<Composer>,
    pub guide_model_filter: Entity<Composer>,
    _subscriptions: Vec<Subscription>,
}
impl Workspace {
    pub fn new(demo: bool, window: &Window, cx: &mut Context<Self>) -> Self {
        // The real server, unless the window is a demo stage (the `live` stage
        // looks at the real server) or asked for the fixtures with `--mock`.
        let stage = std::env::args().nth(2);
        let mock =
            (demo && stage.as_deref() != Some("live")) || std::env::args().any(|a| a == "--mock");
        let source: Box<dyn ThreadSource> = if mock {
            Box::new(MockSource::preview().with_experience(std::env::args().skip(1)))
        } else {
            Box::new(ServerSource::desktop(crate::client::server_arg(
                std::env::args().skip(1),
            )))
        };
        Self::with_source(source, demo, window, cx)
    }

    /// The window over either source, for the render harness and the
    /// connected-inspector test: the production `new` picks the source from
    /// the process arguments instead.
    pub(crate) fn with_source(
        source: Box<dyn ThreadSource>,
        demo: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut subscriptions = vec![];
        let guide_folder = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.placeholder = "Project folder on the server";
            input
        });
        subscriptions.push(
            cx.subscribe(&guide_folder, |this, _, event: &Submitted, cx| {
                this.add_guide_folder(&event.0, cx);
            }),
        );
        let mut guide_filter = |placeholder| {
            let filter = cx.new(|cx| {
                let mut input = Composer::new(cx);
                input.placeholder = placeholder;
                input.height = 36.;
                input
            });
            subscriptions.push(
                cx.subscribe(&filter, |_, _, _: &crate::composer::Changed, cx| {
                    cx.notify()
                }),
            );
            filter
        };
        let guide_provider_filter = guide_filter("Filter providers");
        let guide_model_filter = guide_filter("Filter models");
        let new_composer = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "What should the agent do?";
            c.accepts_assets = true;
            c
        });
        subscriptions.push(
            cx.subscribe(&new_composer, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(
            cx.subscribe(&new_composer, |this, _, event: &Submitted, cx| {
                this.start_thread(event.0.clone(), cx)
            }),
        );
        subscriptions.push(cx.subscribe(&new_composer, |this, _, event: &Queued, cx| {
            this.start_thread(event.0.clone(), cx)
        }));
        subscriptions.push(
            cx.subscribe(&new_composer, |this, composer, event: &Pasted, cx| {
                this.paste_assets(composer, event.0.clone(), cx);
            }),
        );
        let custom_input = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "Write your answer";
            c.height = 40.;
            c
        });
        subscriptions.push(
            cx.subscribe(&custom_input, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &custom_input,
            window,
            |this, _, event: &Submitted, window, cx| this.submit_custom(&event.0, window, cx),
        ));
        let git_input = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.height = 40.;
            c
        });
        subscriptions.push(
            cx.subscribe(&git_input, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &git_input,
            window,
            |this, _, event: &Submitted, window, cx| this.submit_form(&event.0, window, cx),
        ));
        let search = cx.new(|cx| {
            let mut c = Composer::new(cx);
            c.placeholder = "Search models";
            c.surface = "raised";
            c.height = 24.;
            c.size = 14.;
            c
        });
        subscriptions.push(
            cx.subscribe(&search, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &search,
            window,
            |this, _, e: &Submitted, window, cx| {
                if this.palette_open {
                    // Enter on an empty query does nothing: it must not
                    // activate the first row.
                    if e.0.trim().is_empty() {
                        return;
                    }
                    crate::palette::pick_first(this, &e.0, window, cx);
                } else {
                    this.search
                        .update(cx, |input, cx| input.set_text(e.0.clone(), cx));
                }
            },
        ));
        let action_input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.height = 44.;
            input
        });
        subscriptions.push(
            cx.subscribe(&action_input, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &action_input,
            window,
            |this, _, e: &Submitted, window, cx| {
                if this.project_form.is_some() {
                    this.submit_project_action(thread_actions::Submission::Text(&e.0), window, cx);
                } else {
                    this.submit_thread_action(thread_actions::Submission::Text(&e.0), window, cx);
                }
            },
        ));
        let settings_input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.height = 44.;
            input
        });
        subscriptions.push(
            cx.subscribe(&settings_input, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &settings_input,
            window,
            |this, _, e: &Submitted, window, cx| {
                this.submit_settings_text(e.0.clone(), window, cx);
            },
        ));
        let settings_find = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.placeholder = "Search memories";
            input.surface = "raised";
            input.height = 24.;
            input.size = 14.;
            input
        });
        subscriptions.push(
            cx.subscribe(&settings_find, |_, _, _: &crate::composer::Changed, cx| {
                cx.notify()
            }),
        );
        subscriptions.push(cx.subscribe_in(
            &settings_find,
            window,
            |this, _, e: &Submitted, _window, cx| {
                this.submit_memory_search(e.0.clone(), cx);
            },
        ));
        // Redraws when the source's data changes, and each second while a turn
        // runs so its timer counts.
        cx.spawn(async move |this, cx| {
            let mut seen = None;
            let mut ticks = 0u32;
            let mut last_problem_read = Instant::now();
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                ticks = (ticks + 1) % 20;
                if this
                    .update(cx, |this, cx| {
                        if ticks == 0 {
                            this.refresh_work();
                            this.refresh_usage();
                            if this.experience_ui.panel == Some(crate::experience::Panel::Guide)
                                && this.experience_ui.step == 3
                            {
                                this.source.read_embeddings();
                            }
                        }
                        if last_problem_read.elapsed() >= Duration::from_secs(30) {
                            last_problem_read = Instant::now();
                            this.source.read_records();
                        }
                        if this.experience_ui.panel == Some(crate::experience::Panel::Guide)
                            && !this.settings_open
                            && this.guide_motion() == "animated"
                        {
                            cx.notify();
                        }
                        let revision = this.source.revision();
                        if seen != Some(revision) {
                            seen = Some(revision);
                            this.sync_threads(cx);
                            cx.notify();
                        } else if ticks.is_multiple_of(10)
                            && this
                                .source
                                .list_threads()
                                .iter()
                                .any(|t| t.started_at.is_some())
                        {
                            cx.notify();
                        }
                        // A search goes out once the palette's query holds
                        // still, like the TUI's picker waits for a pause.
                        this.sync_search(cx);
                        this.sync_research(cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        if demo {
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let stage = std::env::args().nth(2).unwrap_or_else(|| "main".into());
                this.update_in(cx, |this, window, cx| {
                    match stage.as_str() {
                        "picker" => {
                            this.toggle_picker(window, cx);
                        }
                        "details" => {
                            this.expanded.insert((0, 4), Instant::now());
                            this.lists[0].splice(4..5, 1);
                            this.source.open_commit(0, "5a7bee1");
                            this.git_ui
                                .expanded
                                .insert("commit-5a7bee1:src/workspace.rs".into());
                        }
                        "focus" => {
                            window.focus(&this.tips.tasks, cx);
                        }
                        "input" => {
                            this.stop(cx);
                            this.composers[0]
                                .clone()
                                .update(cx, |c, cx| c.demo_send(window, cx));
                        }
                        _ => {}
                    }
                    cx.notify();
                })
                .expect("demo window is attached");
                if stage == "focus" {
                    cx.update(|window, cx| {
                        window.dispatch_event(
                            PlatformInput::KeyDown(KeyDownEvent {
                                keystroke: Keystroke::parse("tab").expect("tab keystroke"),
                                is_held: false,
                                prefer_character_input: false,
                            }),
                            cx,
                        );
                        // Tab put the window in keyboard mode; land on the
                        // inspector toggle, whose tip names its shortcut.
                        this.update(cx, |this, cx| window.focus(&this.tips.inspector, cx))
                            .expect("workspace is alive");
                    })
                    .expect("demo window is attached");
                }
                cx.background_executor().timer(Duration::from_secs(2)).await;
                #[cfg(feature = "render-harness")]
                capture(cx, &format!("harness-{stage}.png"));
                println!("demo: ready {stage} pid={}", std::process::id());
            })
            .detach();
        }
        let mut this = Self {
            git_ui: crate::git_view::GitUi::new(git_input),
            work_ui: crate::work_view::WorkUi::default(),
            work_focus: cx.focus_handle(),
            creating: false,
            new_composer,
            new_project: None,
            new_scratch: false,
            experience_ui: Default::default(),
            experience_focus: cx.focus_handle(),
            guide_next_focus: cx.focus_handle(),
            guide_folder,
            guide_provider_filter,
            guide_model_filter,
            new_runtime: None,
            new_interaction: 0,
            new_model: None,
            dropdown: None,
            ask_focus: cx.focus_handle(),
            draft: crate::ask::Draft::default(),
            custom_open: false,
            custom_input,
            problem: None,
            new_sending: false,
            improving: false,
            viewer: None,
            viewer_focus: cx.focus_handle(),
            source,
            fold_toggled: HashSet::new(),
            unfolded_at: HashMap::new(),
            shown: HashMap::new(),
            focused: None,
            picker_at: None,
            inspector_at: None,
            tips: Tips {
                jump: cx.focus_handle(),
                tasks: cx.focus_handle(),
                inspector: cx.focus_handle(),
                stop: cx.focus_handle(),
                send: cx.focus_handle(),
            },
            settled_open: false,
            thread_tip: None,
            thread_tip_order: vec![],
            inspector_width: theme::INSPECTOR,
            resizing_inspector: false,
            search,
            thread_popup: None,
            thread_form: None,
            project_popup: None,
            project_form: None,
            notice: None,
            notice_at: None,
            searched: String::new(),
            search_at: None,
            search_epoch: 0,
            proposal_seen: None,
            research_watching: None,
            lead_full: None,
            role_full: None,
            run_role: HashMap::new(),
            run_picks: HashMap::new(),
            run_expanded: HashSet::new(),
            run_hover: None,
            picker: HashMap::new(),
            action_model: None,
            action_input,
            thread_action_focus: cx.focus_handle(),
            settings_open: false,
            settings_tab: ("general".into(), None),
            settings_editor: None,
            settings_price_model: None,
            settings_rail_tip: None,
            settings_entry: None,
            settings_item: None,
            settings_skill: None,
            settings_memory: None,
            settings_form: None,
            settings_form_saving: false,
            settings_confirm: None,
            settings_error: None,
            settings_notice: None,
            settings_input,
            settings_find,
            settings_export: None,
            settings_discovered: None,
            settings_memory_new: None,
            settings_profile_new: None,
            settings_mcp_new: None,
            settings_focus: cx.focus_handle(),
            focus_new_draft: false,
            inspector_open: true,
            tasks_open: true,
            picker_open: false,
            palette_open: false,
            stats_open: false,
            stats_tab: crate::stats::StatsTab::default(),
            stats_range: crate::stats::StatsRange::default(),
            stats_tip: false,
            model_focus: cx.focus_handle(),
            group: 1,
            tab: 1,
            selected: 0,
            chosen: false,
            sidebar_focus: cx.focus_handle(),
            composers: vec![],
            lists: vec![],
            expanded: HashMap::new(),
            _subscriptions: subscriptions,
        };
        if this.source.preview() {
            use crate::experience::Panel;
            let case = std::env::args()
                .skip_while(|arg| arg != "--mock-experience")
                .nth(1);
            this.experience_ui.panel = match case.as_deref() {
                Some("releases") => Some(Panel::Releases),
                Some("problems") => Some(Panel::Problems),
                Some("doctor") => {
                    this.source.read_diagnosis();
                    Some(Panel::Doctor)
                }
                Some("update") => {
                    this.source.read_updates();
                    Some(Panel::Update)
                }
                _ => None,
            };
        }
        this.sync_threads(cx);
        this
    }
    /// Gives every thread the source lists a composer and a transcript list,
    /// and keeps the selection on a thread that is still listed. Threads only
    /// ever appear: the source keeps a gone thread's id.
    pub fn sync_threads(&mut self, cx: &mut Context<Self>) {
        // A later snapshot may name another thread; keep that event queued
        // until the next redraw has sized its per-thread UI.
        let opened = self.source.take_opened();
        let count = self.source.list_threads().len();
        while self.composers.len() < count {
            let id = self.composers.len();
            let composer = cx.new(|cx| {
                let mut composer = Composer::new(cx);
                composer.accepts_assets = true;
                composer
            });
            self._subscriptions.push(
                cx.subscribe(&composer, |_, _, _: &crate::composer::Changed, cx| {
                    cx.notify()
                }),
            );
            self._subscriptions.push(cx.subscribe(
                &composer,
                move |this, _, event: &Submitted, cx| {
                    this.send(id, event.0.clone(), Delivery::Steer, cx)
                },
            ));
            self._subscriptions.push(cx.subscribe(
                &composer,
                |this, composer, event: &Pasted, cx| {
                    this.paste_assets(composer, event.0.clone(), cx);
                },
            ));
            self._subscriptions.push(cx.subscribe(
                &composer,
                move |this, _, event: &Queued, cx| {
                    this.send(id, event.0.clone(), Delivery::Queue, cx)
                },
            ));
            self.composers.push(composer);
        }
        while self.lists.len() < count {
            let id = self.lists.len();
            let messages = self.source.messages(id);
            self.lists.push(ListState::new(
                messages.len(),
                ListAlignment::Top,
                px(theme::HEIGHT),
            ));
            self.shown.insert(id, messages);
        }
        let listed = self.source.order(false);
        if !self.chosen && !listed.is_empty() {
            // The first row the sidebar shows, not a settled thread behind
            // its closed section.
            let threads = self.source.list_threads();
            let top = self
                .source
                .order(true)
                .into_iter()
                .find(|&i| !threads[i].settled);
            self.selected = top.unwrap_or(listed[0]);
            self.chosen = true;
        } else if !listed.contains(&self.selected)
            && let Some(&first) = listed.first()
        {
            self.select(first, cx);
        } else if listed.is_empty()
            && self.chosen
            && !self.creating
            && !self.source.projects().is_empty()
        {
            self.creating = true;
            self.focus_new_draft = true;
        }
        if !listed.is_empty() && self.focused != Some(self.selected) {
            self.focused = Some(self.selected);
            self.source.focus(self.selected);
        }
        self.sync_transcript();
        self.take_news(opened, cx);
        // The tip names a row by its window Y: when the listed rows changed
        // under it (delete, collapse, regroup, reorder), it would point at
        // another thread's title, so drop it.
        let listed = crate::sidebar::visible(self, &self.source.list_threads());
        self.thread_tip =
            crate::sidebar::retain_tip(self.thread_tip, &self.thread_tip_order, &listed);
        if self.thread_tip.is_none() {
            self.thread_tip_order.clear();
        }
    }
    /// What the source reports since the last look: a thread this window
    /// started, a project it added, and anything that failed.
    fn take_news(&mut self, opened: Option<ThreadId>, cx: &mut Context<Self>) {
        if let Some(id) = opened {
            self.thread_form = None;
            self.action_model = None;
            self.creating = false;
            self.selected = id;
            self.focused = None;
            self.new_sending = false;
        }
        if self.source.take_settled() == Some(self.selected) && !self.creating {
            self.creating = true;
            self.new_project = None;
            self.new_scratch = false;
            self.new_model = self.source.selection(self.selected);
            let thread = &self.source.list_threads()[self.selected];
            self.new_runtime = RUNTIME_MODES
                .iter()
                .position(|(mode, _)| *mode == thread.runtime_mode);
            self.new_interaction = INTERACTION_MODES
                .iter()
                .take(3)
                .position(|(mode, _)| *mode == thread.interaction_mode)
                .unwrap_or(0);
            self.focus_new_draft = true;
        }
        if let Some((id, draft)) = self.source.take_reverted() {
            if id == self.selected {
                self.set_inspector(false);
            }
            if let Some(draft) = draft {
                self.composers[id].update(cx, |composer, cx| {
                    let current = composer.text();
                    let text = if current.is_empty() {
                        draft
                    } else {
                        format!("{draft}\n{current}")
                    };
                    composer.set_text(text, cx);
                });
            }
        }
        if !self.creating
            && self.thread_form.is_none()
            && self.thread_popup.is_none()
            && !self.palette_open
            && !self.picker_open
            && self.dropdown.is_none()
            && !self.custom_open
            && self.git_ui.form.is_none()
            && let Some(answer) = self.source.read_side_answer(self.selected, true)
        {
            self.thread_form = Some(thread_actions::Form::Answer(answer));
        }
        if let Some(project) = self.source.take_added() {
            self.new_project = Some(project);
            self.new_scratch = false;
        }
        while let Some(problem) = self.source.take_problem() {
            self.problem = Some(problem.message);
            let Some((at, prompt)) = problem.unsent else {
                continue;
            };
            let composer = match at {
                Some(id) if id < self.composers.len() => self.composers[id].clone(),
                _ => {
                    self.new_sending = false;
                    self.new_composer.clone()
                }
            };
            composer.update(cx, |c, cx| c.restore(prompt, cx));
        }
        while let Some((request, improved)) = self.source.take_improvement() {
            self.improving = false;
            if let Some(improved) = improved {
                let composer = self.active_composer().clone();
                if request.still_matches(
                    self.destination().as_ref(),
                    self.effective_selection().as_ref(),
                    self.source
                        .composer_directory(&request.destination)
                        .as_deref(),
                    composer.read(cx).revision,
                ) {
                    composer.update(cx, |c, cx| {
                        c.set_text(improved, cx);
                        c.undo_improvement = Some(request.original);
                    });
                } else {
                    self.problem = Some("The draft changed while it was being improved. Your current draft was kept.".into());
                }
            }
        }
        // The server parked the run-size question: the next send asks for it.
        // The notice clears itself, as the TUI's toast does after 2.5s.
        if self.source.take_research_pending() {
            self.notice = Some(crate::language::message("send.researchSizePending").into());
            self.notice_at = Some(Instant::now());
        }
        if self
            .notice_at
            .is_some_and(|at| at.elapsed() >= Duration::from_millis(2500))
        {
            self.notice = None;
            self.notice_at = None;
        }
    }
    /// How long the palette's query holds still before the store is searched.
    const SEARCH_DEBOUNCE: Duration = Duration::from_millis(200);
    /// Sends the palette's query once it holds still, like the TUI's picker
    /// waits for a pause in typing.
    fn sync_search(&mut self, cx: &mut Context<Self>) {
        let epoch = self.source.wire_epoch();
        if epoch != self.search_epoch {
            // A reconnect drops the last answer: ask again for what the
            // palette still shows, instead of keeping a stale error or empty
            // result until the query changes.
            self.search_epoch = epoch;
            self.searched = String::new();
            self.search_at = None;
        }
        if !self.palette_open {
            self.searched = String::new();
            self.search_at = None;
            return;
        }
        let query = self.search.read(cx).text().to_string();
        if query.trim().is_empty() {
            self.searched = String::new();
            self.search_at = None;
            self.source.search_threads("");
            return;
        }
        if query == self.searched {
            return;
        }
        let now = Instant::now();
        if self
            .search_at
            .as_ref()
            .is_none_or(|(_, pending)| pending != &query)
        {
            self.search_at = Some((now, query));
            return;
        }
        if self
            .search_at
            .as_ref()
            .is_some_and(|(at, _)| now.duration_since(*at) >= Self::SEARCH_DEBOUNCE)
        {
            self.searched = query.clone();
            self.search_at = None;
            self.source.search_threads(&query);
            cx.notify();
        }
    }
    /// The thread the server may ask this window for a run size: the focused
    /// thread while it can start one (Research mode is on, `/research` is
    /// typed, or the thread orchestrates), none otherwise.
    fn research_target(&self, cx: &mut Context<Self>) -> Option<ThreadId> {
        if self.creating || self.composers.len() <= self.selected {
            return None;
        }
        let thread = self.source.list_threads().get(self.selected)?.clone();
        let composer = self.composers[self.selected].read(cx);
        let drafted = composer_menu::mode_command(composer.text())
            .is_some_and(|(mode, _)| mode == "research");
        let research = thread.interaction_mode == "research"
            || thread.interaction_mode == "orchestrate"
            || composer.once.as_deref() == Some("research")
            || drafted;
        research.then_some(self.selected)
    }
    /// Keeps the run-size opt-in on the focused thread and the run view's
    /// reads going while it shows.
    fn sync_research(&mut self, cx: &mut Context<Self>) {
        let target = self.research_target(cx);
        if target != self.research_watching {
            self.research_watching = target;
            self.source.watch_research(target);
        }
        if !self.creating && self.source.leads_run(self.selected) {
            self.source.read_run(self.selected);
        }
        // One subscription per visible role thread while the run view shows
        // it, with deltas; released when leaving the view, switching threads
        // or disconnecting (the live source ends them).
        let visible = self.visible_role_threads();
        self.source.watch_roles(visible);
    }

    /// The role threads the run view shows now, by their id on the wire.
    fn visible_role_threads(&self) -> Vec<String> {
        if self.creating {
            return vec![];
        }
        if let Some((lead, role, agent)) = self.role_full {
            return self
                .source
                .run_summary(lead)
                .and_then(|summary| summary.agents[role as usize].get(agent)?.thread_id.clone())
                .into_iter()
                .collect();
        }
        if !self.show_run_view() {
            return vec![];
        }
        let Some(summary) = self.source.run_summary(self.selected) else {
            return vec![];
        };
        crate::model::ROLES
            .into_iter()
            .filter_map(|role| {
                let at = self
                    .run_shown(self.selected, role)
                    .min(summary.agents[role as usize].len().saturating_sub(1));
                summary.agents[role as usize].get(at)?.thread_id.clone()
            })
            .collect()
    }
    /// The lead's run view replaces its transcript: the shell lists it
    /// leading a run and the run is read, and it is not opened in full.
    pub fn show_run_view(&self) -> bool {
        !self.creating
            && self.role_full.is_none()
            && self.lead_full != Some(self.selected)
            && self.source.leads_run(self.selected)
            && self.source.run_summary(self.selected).is_some()
    }
    /// How wide the reading column is now: the window past the sidebar and
    /// the inspector, never below what the turn needs.
    pub fn turn_width(&self, window: &Window) -> f32 {
        let viewport = f32::from(window.viewport_size().width);
        let taken = theme::SIDEBAR
            + if self.inspector_open {
                self.inspector_width
            } else {
                0.
            };
        (viewport - taken).max(MIN_TURN)
    }
    /// The lead a role thread (or a lead opened in full) goes back to.
    pub fn run_back_to(&self) -> Option<ThreadId> {
        if self.show_run_view() {
            return None;
        }
        if let Some((lead, _, _)) = self.role_full {
            return Some(lead);
        }
        if self.lead_full == Some(self.selected) {
            return Some(self.selected);
        }
        None
    }
    /// Leaves the full transcript for the run view.
    pub fn back_to_run(&mut self, cx: &mut Context<Self>) {
        if self.run_back_to().is_none() {
            return;
        }
        self.lead_full = None;
        self.role_full = None;
        cx.notify();
    }
    /// The project a new thread starts in: the one picked, else the open
    /// thread's, else the newest.
    pub fn new_project_id(&self) -> Option<String> {
        if self.new_scratch {
            return None;
        }
        let projects = self.source.projects();
        self.new_project
            .clone()
            .filter(|id| projects.iter().any(|p| &p.id == id))
            .or_else(|| {
                let pid = self.source.project_id(self.selected).or_else(|| {
                    self.source
                        .list_threads()
                        .get(self.selected)
                        .map(|thread| thread.project.clone())
                })?;
                projects.iter().any(|p| p.id == pid).then_some(pid)
            })
            .or_else(|| projects.first().map(|p| p.id.clone()))
    }
    /// The model the open thread runs on, or the new thread would start on.
    pub fn effective_selection(&self) -> Option<Selection> {
        if self.choosing_action_model() {
            self.action_model.clone()
        } else if self.creating {
            self.new_model
                .clone()
                .or_else(|| self.source.project_selection(&self.new_project_id()?))
        } else {
            self.source.selection(self.selected)
        }
    }
    pub fn choosing_action_model(&self) -> bool {
        self.thread_form
            .as_ref()
            .is_some_and(thread_actions::Form::chooses_model)
    }
    /// The catalog, once read.
    pub fn catalog(&self) -> Option<std::sync::Arc<Catalog>> {
        match self.source.catalog() {
            CatalogState::Ready(catalog) => Some(catalog),
            _ => None,
        }
    }
    /// A model's name and the token it is drawn in: the catalog's name once
    /// known, a readable form of the slug until then.
    pub fn model_label(&self, selection: Option<&Selection>) -> (String, &'static str) {
        let Some(selection) = selection else {
            return (crate::language::tr("Default model").into_owned(), "ink");
        };
        let catalog = self.catalog();
        let name = catalog
            .as_ref()
            .map_or_else(|| prettify(&selection.model), |c| c.model_name(selection));
        let driver = catalog
            .as_ref()
            .and_then(|c| c.provider(&selection.instance))
            .map_or("", |p| p.driver.as_str());
        (name, provider_color(driver, &selection.instance))
    }
    /// Switches the model of the open thread, or of the new one: what still
    /// applies of the old choice carries over (`Catalog::rebase`).
    pub fn choose_model(&mut self, instance: &str, model: &str, cx: &mut Context<Self>) {
        let Some(catalog) = self.catalog() else {
            return;
        };
        let next = catalog.rebase(self.effective_selection().as_ref(), instance, model);
        self.apply_selection(next);
        if !self.choosing_action_model() {
            self.picker_open = false;
        }
        cx.notify();
    }
    /// Sets one option of the current model, e.g. its reasoning level.
    pub fn choose_option(&mut self, option: &str, value: &str, cx: &mut Context<Self>) {
        if let Some(current) = self.effective_selection() {
            self.apply_selection(current.with_option(option, value));
            cx.notify();
        }
    }
    fn apply_selection(&mut self, selection: Selection) {
        if self.choosing_action_model() {
            self.action_model = Some(selection);
        } else if self.creating {
            self.new_model = Some(selection);
        } else {
            self.source.set_model(self.selected, selection);
        }
    }
    pub fn thread_project_title(&self, project: &str, fallback: &str) -> String {
        self.source
            .projects()
            .into_iter()
            .find(|entry| entry.id == project)
            .map_or_else(
                || {
                    if fallback == "Unknown project" {
                        crate::language::capitalized(crate::language::message(
                            "sidebar.unknownProject",
                        ))
                    } else {
                        fallback.to_owned()
                    }
                },
                |entry| entry.title,
            )
    }
    pub fn new_project_title(&self) -> Option<String> {
        if !self.creating {
            return None;
        }
        if self.new_scratch {
            return Some(crate::language::message("guide.noProjectChoice").into());
        }
        let id = self.new_project_id()?;
        self.source
            .projects()
            .into_iter()
            .find(|p| p.id == id)
            .map(|p| p.title)
    }
    /// Starts drafting a thread in the open thread's project.
    pub fn new_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.creating = true;
        self.new_project = None;
        self.new_scratch = self.source.projects().is_empty();
        self.new_model = None;
        self.dropdown = None;
        self.picker_open = false;
        window.focus(&self.new_composer.read(cx).focus.clone(), cx);
        cx.notify();
    }
    fn start_thread(&mut self, text: String, cx: &mut Context<Self>) {
        if text.trim().is_empty() && self.new_composer.read(cx).assets.is_empty() {
            return;
        }
        let project = self.new_project_id();
        if project.is_none() && !self.new_scratch {
            self.problem = Some("There is no project to start a thread in.".into());
            self.new_composer.update(cx, |c, cx| c.set_text(text, cx));
            cx.notify();
            return;
        }
        if self.new_sending {
            self.new_composer.update(cx, |c, cx| c.set_text(text, cx));
            return;
        }
        let Some(prompt) = self.take_prompt(self.new_composer.clone(), text, false, cx) else {
            return;
        };
        self.new_sending = true;
        self.source.create_thread(NewThread {
            project,
            prompt,
            runtime_mode: self.new_runtime.map(|at| RUNTIME_MODES[at].0.into()),
            interaction_mode: INTERACTION_MODES[self.new_interaction].0.into(),
            model: self.new_model.clone(),
        });
        // Stays in the draft view until the thread is listed; the source then
        // names it (`take_opened`), which the redraw loop picks up.
        cx.notify();
    }
    fn destination(&self) -> Option<Destination> {
        if self.creating {
            self.new_project_id().map(Destination::Project)
        } else {
            Some(Destination::Thread(self.selected))
        }
    }
    pub fn pick_attachments(&mut self, directories: bool, cx: &mut Context<Self>) {
        let composer = self.active_composer().clone();
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: !directories,
            directories,
            multiple: true,
            prompt: Some(
                if directories {
                    "Attach folders"
                } else {
                    "Attach files or images"
                }
                .into(),
            ),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = picked.await {
                this.update(cx, |this, cx| match result {
                    Ok(Some(paths)) => this.load_assets(composer, paths, vec![], cx),
                    Ok(None) => {}
                    Err(error) => {
                        this.problem =
                            Some(format!("Could not open the attachment picker: {error}"));
                        cx.notify();
                    }
                })
                .ok();
            }
        })
        .detach();
    }
    pub fn drop_attachments(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        self.load_assets(self.active_composer().clone(), paths, vec![], cx);
    }
    fn paste_assets(
        &mut self,
        composer: Entity<Composer>,
        entries: Vec<ClipboardEntry>,
        cx: &mut Context<Self>,
    ) {
        let mut paths = vec![];
        let mut images = vec![];
        for entry in entries {
            match entry {
                ClipboardEntry::ExternalPaths(files) => paths.extend_from_slice(files.paths()),
                ClipboardEntry::Image(image) => images.push(image),
                _ => {}
            }
        }
        self.load_assets(composer, paths, images, cx);
    }
    fn load_assets(
        &mut self,
        composer: Entity<Composer>,
        paths: Vec<PathBuf>,
        images: Vec<Image>,
        cx: &mut Context<Self>,
    ) {
        composer.update(cx, |c, cx| {
            c.loading_assets += 1;
            c.changed(cx);
        });
        // Past 20 images the API allows 2000 px a side, not 8000: shrink for the set being built.
        let existing = composer
            .read(cx)
            .assets
            .iter()
            .filter(|asset| matches!(asset, Asset::Image { .. }))
            .count();
        let many = existing
            + images.len()
            + paths
                .iter()
                .filter(|path| Asset::image_format(path).is_some())
                .count()
            > attachments::MANY_IMAGES;
        let loaded = cx.background_executor().spawn(async move {
            paths
                .into_iter()
                .map(|path| Asset::local(path, many))
                .chain(images.into_iter().enumerate().map(|(at, image)| {
                    Asset::image(
                        format!("Clipboard {}.{}", at + 1, image.format.extension()),
                        image,
                        many,
                    )
                }))
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let loaded = loaded.await;
            this.update(cx, |this, cx| {
                composer.update(cx, |composer, cx| {
                    composer.loading_assets -= 1;
                    let mut added = false;
                    for result in loaded {
                        match result {
                            Ok(asset) if !composer.assets.contains(&asset) => {
                                composer.assets.push(asset);
                                if let Err(error) = attachments::limit(&composer.assets) {
                                    composer.assets.pop();
                                    this.problem = Some(error.into());
                                } else {
                                    added = true;
                                }
                            }
                            Ok(_) => {}
                            Err(error) => this.problem = Some(error),
                        }
                    }
                    if added {
                        composer.changed(cx);
                    }
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    pub fn improve_draft(&mut self, cx: &mut Context<Self>) {
        if self.improving {
            return;
        }
        let Some(destination) = self.destination() else {
            return;
        };
        let Some(directory) = self.source.composer_directory(&destination) else {
            self.problem = Some("Choose a project before improving the draft.".into());
            cx.notify();
            return;
        };
        let c = self.active_composer().read(cx);
        if c.text().trim().is_empty() || composer_menu::mode_command(c.text()).is_some() {
            return;
        }
        let request = Improvement {
            destination,
            directory,
            revision: c.revision,
            selection: self.effective_selection(),
            original: c.text().into(),
        };
        self.improving = true;
        self.source.improve(request);
        cx.notify();
    }
    fn sync_slash(&mut self, cx: &mut Context<Self>) {
        if !self.composer_visible() {
            return;
        }
        let composer = self.active_composer().clone();
        let Some((_, prefix)) = composer.read(cx).slash() else {
            if !composer.read(cx).choices.is_empty() {
                composer.update(cx, |c, _| c.choices.clear());
            }
            return;
        };
        let prefix = prefix.to_owned();
        let inventory = self.destination().and_then(|destination| {
            let selection = self.effective_selection();
            self.source.read_skills(&destination, selection.as_ref());
            self.source.skills(&destination, selection.as_ref())
        });
        let choices = composer_menu::choices(
            &prefix,
            inventory.as_deref().and_then(|result| result.as_ref().ok()),
            self.composer_busy(),
        );
        composer.update(cx, |c, _| {
            c.choice = c.choice.min(choices.len().saturating_sub(1));
            c.choices = choices;
        });
    }
    pub fn composer_busy(&self) -> bool {
        !self.creating
            && self
                .source
                .list_threads()
                .get(self.selected)
                .is_some_and(|thread| matches!(thread.status, Status::Running | Status::Held))
    }
    fn composer_visible(&self) -> bool {
        self.creating
            || (!self.composers.is_empty()
                && self.source.permission(self.selected).is_none()
                && self.source.ask(self.selected).is_none())
    }
    /// Adds a folder as a project, asking for it with the system's picker.
    pub fn add_project(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add project".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.first() else { return };
            let path = path.to_string_lossy().into_owned();
            this.update(cx, |this, cx| {
                this.source.add_project(path);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    /// Sets how the open thread (or the new one) runs.
    pub fn set_access(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.creating {
            self.new_runtime = Some(index);
        } else {
            let thread = self.source.list_threads()[self.selected].clone();
            self.source.set_modes(
                self.selected,
                RUNTIME_MODES[index].0,
                &thread.interaction_mode,
            );
        }
        self.dropdown = None;
        cx.notify();
    }
    pub fn set_mode(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.creating {
            self.new_interaction = index;
        } else {
            let thread = self.source.list_threads()[self.selected].clone();
            self.source.set_modes(
                self.selected,
                &thread.runtime_mode,
                INTERACTION_MODES[index].0,
            );
        }
        self.dropdown = None;
        cx.notify();
    }
    pub fn edit_queued(&mut self, key: &str, edit: QueueEdit, cx: &mut Context<Self>) {
        self.source.edit_queued(self.selected, key, edit);
        cx.notify();
    }
    /// Takes a waiting message back into the draft to change it.
    pub fn edit_queued_text(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let queued = self
            .source
            .queued(self.selected)
            .into_iter()
            .find(|queued| queued.key == key);
        if let Some(queued) = queued {
            let mut loading = false;
            for image in &queued.images {
                match self.source.image(&image.source) {
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        self.problem = Some(error);
                        cx.notify();
                        return;
                    }
                    None => {
                        self.source.read_image(&image.source);
                        loading = true;
                    }
                }
            }
            if loading {
                self.problem = Some(
                    "Loading the queued attachments. Choose Edit again once they load.".into(),
                );
                cx.notify();
                return;
            }
        }
        if let Some(prompt) = self.source.take_queued(self.selected, key) {
            let composer = self.composers[self.selected].clone();
            composer.update(cx, |c, cx| c.restore(prompt, cx));
            window.focus(&composer.read(cx).focus.clone(), cx);
            cx.notify();
        }
    }
    /// Re-reads usage while it is on screen: the account's limits and
    /// protection on their timers, and the open thread's context on the TUI's
    /// timer — the status line shows it whether or not the Context tab does.
    pub fn refresh_usage(&mut self) {
        if self.source.preview() {
            return;
        }
        self.source.read_limits();
        self.source.read_protection();
        if !self.creating {
            self.source.read_context(self.selected);
        }
        if self.stats_open && self.source.stats(self.stats_range).is_none() {
            self.source.read_stats(self.stats_range);
        }
    }
    /// Resizes the open thread's list to a live transcript that changed:
    /// everything from the first changed row is measured again, and a reader
    /// who is at the end stays there as it grows. The mock changes its list
    /// itself, so it is left alone.
    fn sync_transcript(&mut self) {
        if self.source.preview() || self.selected >= self.lists.len() {
            return;
        }
        let id = self.selected;
        let now = self.source.messages(id);
        let Some(before) = self.shown.get(&id).cloned() else {
            return;
        };
        if std::sync::Arc::ptr_eq(&before, &now) {
            return;
        }
        let common = before
            .iter()
            .zip(now.iter())
            .take_while(|(a, b)| a == b)
            .count();
        let list = &self.lists[id];
        // Following the end: the first thing seen, or one of the last rows on screen.
        let following = before.is_empty() || list.logical_scroll_top().item_ix + 8 >= before.len();
        list.splice(common..before.len(), now.len() - common);
        if following {
            list.scroll_to_end();
        }
        self.shown.insert(id, now);
    }
    /// Whether a run of `len` steps starting at `start` shows only its summary.
    /// Finished runs fold; the last run of the thread stays open while it is
    /// the end of the conversation. A click flips either.
    pub fn run_folded(&self, id: ThreadId, start: usize, len: usize, total: usize) -> bool {
        (start + len != total) != self.fold_toggled.contains(&(id, start))
    }
    /// The composer the window is writing into: the new thread's, or the open one's.
    pub fn active_composer(&self) -> &Entity<Composer> {
        if self.creating {
            &self.new_composer
        } else {
            &self.composers[self.selected]
        }
    }
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.source.retry();
        cx.notify();
    }
    pub fn select(&mut self, id: ThreadId, cx: &mut Context<Self>) {
        self.selected = id;
        self.creating = false;
        self.dropdown = None;
        self.lead_full = None;
        self.role_full = None;
        // A click selects the row, which drops its tip: the full title
        // would otherwise stay where it opened, over the rows below.
        self.clear_thread_tip();
        cx.notify();
    }
    /// The thread the window chrome may present: none while the new-thread
    /// draft is active, so the sidebar, title bar and status line never show
    /// the open thread's state behind the draft.
    pub fn shown_thread(creating: bool, selected: ThreadId) -> Option<ThreadId> {
        (!creating).then_some(selected)
    }

    /// Drops the sidebar row tip and the listed rows it was taken against.
    pub fn clear_thread_tip(&mut self) {
        self.thread_tip = None;
        self.thread_tip_order.clear();
    }
    pub fn open_stats(&mut self, cx: &mut Context<Self>) {
        self.stats_open = true;
        self.stats_tab = crate::stats::StatsTab::default();
        self.source.read_stats(self.stats_range);
        cx.notify();
    }
    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.thread_form.is_some() || self.project_form.is_some() {
            return;
        }
        self.thread_popup = None;
        self.dropdown = None;
        self.palette_open = true;
        self.picker_open = false;
        self.search.update(cx, |c, cx| {
            c.placeholder = "Search threads and actions";
            c.set_text(String::new(), cx);
        });
        window.focus(&self.search.read(cx).focus.clone(), cx);
        cx.notify();
    }
    /// Opens or closes the inspector, timing the slide.
    pub fn set_inspector(&mut self, open: bool) {
        if self.inspector_open != open {
            self.inspector_open = open;
            self.inspector_at = Some(Instant::now());
        }
    }
    pub fn toggle_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.thread_form.is_some() || self.thread_popup.is_some() {
            return;
        }
        self.picker_open = !self.picker_open;
        if self.picker_open {
            // A model may have been hidden or a provider signed in since it was read.
            self.source.refresh_catalog();
        }
        self.picker_at = Some(Instant::now());
        self.palette_open = false;
        self.search.update(cx, |c, cx| {
            c.placeholder = "Search models";
            c.set_text(String::new(), cx);
        });
        window.focus(
            &if self.picker_open {
                self.search.read(cx).focus.clone()
            } else {
                self.model_focus.clone()
            },
            cx,
        );
        cx.notify();
    }
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        // Escape also reaches here with nothing running; that interrupts nothing.
        let running = self.source.list_threads()[self.selected].status == Status::Running;
        if !running && !self.source.preview() {
            return;
        }
        self.source.stop(self.selected);
        self.composers[self.selected].update(cx, |c, cx| {
            c.enabled = true;
            cx.notify();
        });
        cx.notify();
    }
    fn send(&mut self, id: ThreadId, text: String, delivery: Delivery, cx: &mut Context<Self>) {
        // The run-size question waits: Enter starts the run with the picked
        // size, as the TUI's modal does. The typed draft stays in the
        // composer: answering is not a send.
        if !self.creating && self.source.proposal(id).is_some() {
            if !text.is_empty() {
                self.composers[id].update(cx, |c, cx| c.set_text(text, cx));
            }
            self.answer_size(id, cx);
            return;
        }
        // An empty Enter with nothing waiting sends nothing: the composer
        // already cleared its (empty) draft to get here.
        if text.trim().is_empty()
            && self
                .composers
                .get(id)
                .is_none_or(|composer| composer.read(cx).assets.is_empty())
        {
            return;
        }
        let busy = self
            .source
            .list_threads()
            .get(id)
            .is_some_and(|thread| matches!(thread.status, Status::Running | Status::Held));
        let Some(prompt) = self.take_prompt(self.composers[id].clone(), text, busy, cx) else {
            return;
        };
        let reply = self.source.send_message(id, prompt, delivery);
        self.animate(id, reply, cx);
    }
    fn take_prompt(
        &mut self,
        composer: Entity<Composer>,
        mut text: String,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> Option<Prompt> {
        composer.update(cx, |c, cx| {
            if let Err(error) = attachments::limit(&c.assets) {
                self.problem = Some(error.into());
                c.set_text(text, cx);
                return None;
            }
            if let Some((mode, rest)) = composer_menu::mode_command(&text) {
                if busy {
                    self.problem =
                        Some("Use a one-off mode after the current turn finishes.".into());
                    c.set_text(text, cx);
                    return None;
                }
                c.once = Some(mode.into());
                if rest.is_empty() && c.assets.is_empty() {
                    c.changed(cx);
                    return None;
                }
                text = rest.into();
            }
            Some(Prompt {
                text,
                assets: std::mem::take(&mut c.assets),
                once: if busy { None } else { c.once.take() },
            })
        })
    }
    /// Plays a simulated reply (the mock's); a live source has none.
    fn animate(&mut self, id: ThreadId, reply: Option<Reply>, cx: &mut Context<Self>) {
        let Some(reply) = reply else {
            cx.notify();
            return;
        };
        self.lists[id].splice(reply.message - 1..reply.message - 1, 2);
        self.lists[id].scroll_to_end();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let count = reply.words.len();
            for (i, word) in reply.words.into_iter().enumerate() {
                cx.background_executor()
                    .timer(Duration::from_millis(65))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        this.source
                            .stream_word(id, reply.message, &word, i + 1 == count);
                        if i + 1 == count
                            && this.source.list_threads()[id].status
                                != crate::model::Status::Running
                        {
                            this.composers[id].update(cx, |c, cx| {
                                c.enabled = true;
                                cx.notify();
                            });
                        }
                        this.lists[id].splice(reply.message..reply.message + 1, 1);
                        this.lists[id].scroll_to_end();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }
    /// Stops the running turn so the waiting message goes next.
    pub fn send_queued_now(&mut self, key: &str, cx: &mut Context<Self>) {
        let reply = self.source.send_queued_now(self.selected, key);
        self.animate(self.selected, reply, cx);
    }
}

#[cfg(feature = "render-harness")]
fn capture(cx: &mut AsyncWindowContext, name: &str) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("screenshots")
            .join(name);
        window
            .render_to_image()
            .expect("render demo frame")
            .save(path)
            .expect("save demo frame");
    })
    .expect("demo window remains open");
}
impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = self.source.settings();
        let setting = |key| {
            settings
                .as_deref()
                .and_then(|result| result.as_ref().ok())
                .and_then(|snapshot| snapshot.find(key))
                .and_then(|view| match &view.value {
                    crate::settings::SettingValue::Text(text) => Some(text.as_str()),
                    _ => None,
                })
        };
        crate::theme::apply(setting("ui.theme"));
        crate::language::apply(setting("ui.language"), self.source.client_locale());
        // A snapshot can arrive between two polls; never draw a thread that
        // has no composer or list yet.
        self.sync_threads(cx);
        if self.source.connection() != crate::model::Connection::Live {
            return crate::connection::render(self, cx).into_any_element();
        }
        self.sync_experience(window, cx);
        let has_thread = !self.source.list_threads().is_empty();
        if has_thread {
            self.sync_panel(window, cx);
            self.sync_inspector();
            self.sync_work();
        }
        if self.creating || (has_thread && !self.source.order(false).is_empty()) {
            self.sync_slash(cx);
        }
        if self.focus_new_draft {
            self.focus_new_draft = false;
            window.focus(&self.new_composer.read(cx).focus.clone(), cx);
        }
        let viewport = f32::from(window.viewport_size().width);
        let room = (viewport - theme::SIDEBAR - MIN_TURN).max(MIN_INSPECTOR);
        let slide = crate::ui::progress(self.inspector_at, 160, window);
        let shown = if self.inspector_open {
            slide
        } else {
            1. - slide
        };
        let inspector_width = self.inspector_width.clamp(MIN_INSPECTOR, room);
        div()
            .relative()
            .font_family(theme::FONT)
            .size_full()
            .flex()
            .flex_col()
            .bg(color("ground"))
            .on_action(
                cx.listener(|this, _: &crate::palette::OpenPalette, window, cx| {
                    this.open_palette(window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::palette::NextFocus, window, cx| {
                    if this.composer_visible() && this.dropdown.is_none() {
                        let composer = this.active_composer();
                        let draft = composer.read(cx);
                        if draft.focus.is_focused(window)
                            && !draft.choices.is_empty()
                            && composer.update(cx, |c, cx| c.choose(c.choice, window, cx))
                        {
                            return;
                        }
                    }
                    window.focus_next(cx);
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::palette::PreviousFocus, window, cx| {
                    if this.viewer.is_none()
                        && this.composer_visible()
                        && this.active_composer().read(cx).focus.is_focused(window)
                        && !this.composer_busy()
                    {
                        let current = if this.creating {
                            this.new_interaction
                        } else {
                            let threads = this.source.list_threads();
                            INTERACTION_MODES[..3]
                                .iter()
                                .position(|(mode, _)| {
                                    *mode == threads[this.selected].interaction_mode
                                })
                                .unwrap_or(2)
                        };
                        this.set_mode((current + 1) % 3, cx);
                    } else {
                        window.focus_prev(cx);
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::settings_view::OpenSettings, window, cx| {
                    if !this.settings_open {
                        this.open_settings(window, cx);
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &thread_actions::OpenMenu, window, cx| {
                    if this.thread_form.is_none()
                        && !this.creating
                        && !thread_actions::items(this, this.selected).is_empty()
                    {
                        this.open_thread_menu(
                            this.selected,
                            point(px(16.), px(78.)),
                            None,
                            window,
                            cx,
                        );
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &thread_actions::RenameThread, window, cx| {
                    if this.thread_form.is_none()
                        && !this.creating
                        && thread_actions::items(this, this.selected)
                            .contains(&thread_actions::Item::Rename)
                    {
                        this.pick_thread_action(
                            this.selected,
                            thread_actions::Item::Rename,
                            window,
                            cx,
                        );
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &thread_actions::ConfirmAction, window, cx| {
                    this.submit_thread_action(thread_actions::Submission::Confirm, window, cx);
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::palette::Dismiss, window, cx| {
                    if this.viewer.is_some() {
                        this.close_viewer(window, cx);
                    } else if this.settings_open {
                        this.close_settings_over(window, cx);
                    } else if this.experience_ui.panel.is_some() {
                        this.close_experience(window, cx);
                    } else if this.thread_form.is_some() || this.thread_popup.is_some() {
                        this.close_thread_action(window, cx);
                    } else if this.project_form.is_some() || this.project_popup.is_some() {
                        this.close_project_action(window, cx);
                    } else if this.role_full.is_some() || this.lead_full.is_some() {
                        this.back_to_run(cx);
                    } else if !this.creating && this.source.proposal(this.selected).is_some() {
                        // The run-size question waits: Esc runs one researcher
                        // instead, as the TUI's modal does.
                        this.answer_single(this.selected, cx);
                    } else if this.custom_open {
                        this.close_custom(window, cx);
                    } else if this.git_ui.form.is_some() {
                        this.close_form(window, cx);
                    } else if this.dropdown.is_some() {
                        this.dropdown = None;
                    } else if this.picker_open {
                        this.picker_open = false;
                        window.focus(&this.model_focus, cx);
                    } else if this.palette_open {
                        this.palette_open = false;
                        window.focus(&this.sidebar_focus, cx);
                    } else if this.stats_open {
                        this.stats_open = false;
                    } else if this.composer_visible()
                        && this.active_composer().read(cx).slash().is_some()
                    {
                        this.active_composer().update(cx, |c, _| {
                            c.slash_dismissed = true;
                            c.choices.clear();
                        });
                    } else if this.creating {
                        this.creating = this.source.order(false).is_empty();
                        window.focus(&this.sidebar_focus, cx);
                    } else if !this.source.order(false).is_empty() {
                        use crate::work_view::Escape;
                        match this.work_ui.escape(this.source.as_ref(), this.selected) {
                            Escape::CloseDetail | Escape::KeepApproval => {}
                            Escape::DismissQuestion => this.dismiss_ask(cx),
                            Escape::StopTurn => this.stop(cx),
                        }
                    }
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.resizing_inspector {
                    let viewport = f32::from(window.viewport_size().width);
                    this.inspector_width =
                        f32::from(window.viewport_size().width - event.position.x).clamp(
                            MIN_INSPECTOR,
                            (viewport - theme::SIDEBAR - MIN_TURN).max(MIN_INSPECTOR),
                        );
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.resizing_inspector = false;
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleInspector, _, cx| {
                    this.set_inspector(!this.inspector_open);
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::title_bar::ToggleTasks, _, cx| {
                    if this.inspector_open {
                        this.tasks_open = !this.tasks_open;
                    } else {
                        this.tasks_open = true;
                        this.set_inspector(true);
                    }
                    cx.notify();
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::model_picker::TogglePicker, window, cx| {
                    this.toggle_picker(window, cx)
                }),
            )
            .text_size(px(theme::UI))
            .line_height(px(theme::UI_LINE))
            .text_color(color("ink"))
            .when(has_thread, |s| {
                s.child(crate::title_bar::render(self, window, cx))
            })
            .child(crate::experience_view::notices(self, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(crate::sidebar::render(self, window, cx))
                    .when(
                        self.creating || (has_thread && !self.source.order(false).is_empty()),
                        |s| s.child(crate::thread_view::render(self, window, cx)),
                    )
                    .when(
                        !self.creating && (!has_thread || self.source.order(false).is_empty()),
                        |s| s.child(crate::connection::render(self, cx)),
                    )
                    .when(has_thread && shown > 0. && !self.creating, |s| {
                        // Slides in from the window's right edge: the pane
                        // keeps its width and the clip around it grows. A
                        // new-thread draft hides the old thread's pane; its
                        // visibility and tab survive for the return.
                        s.child(
                            div()
                                .h_full()
                                .flex_shrink_0()
                                .flex()
                                .justify_end()
                                .overflow_hidden()
                                .w(px(inspector_width * shown))
                                .opacity(0.4 + 0.6 * shown)
                                .child(crate::inspector::render(self, inspector_width, cx)),
                        )
                    }),
            )
            .when(self.palette_open, |s| {
                s.child(crate::palette::render(self, cx))
            })
            .when_some(self.thread_popup.as_ref(), |s, popup| {
                s.child(crate::thread_actions::popup(self, popup, window, cx))
            })
            .when_some(self.thread_form.as_ref(), |s, form| {
                s.child(crate::thread_actions::form(self, form, window, cx))
            })
            .when_some(self.project_popup.as_ref(), |s, popup| {
                s.child(crate::thread_actions::project_popup(
                    self, popup, window, cx,
                ))
            })
            .when_some(self.project_form.as_ref(), |s, form| {
                s.child(crate::thread_actions::project_form(self, form, window, cx))
            })
            .when_some(self.experience_ui.panel, |s, panel| {
                s.child(crate::experience_view::render(self, panel, window, cx))
            })
            .when(self.settings_open, |s| {
                s.child(crate::settings_view::render(self, window, cx))
            })
            .when_some(self.viewer.as_ref(), |s, viewer| {
                s.child(crate::image_view::render(self, viewer, window, cx))
            })
            .when_some(self.thread_tip, |s, (id, y)| {
                // Beside the hovered sidebar row: a window tooltip here would
                // hang over the rows below, and linger there after a click.
                // Only a truncated, unselected title earns it.
                if id == self.selected
                    || self.thread_popup.is_some()
                    || self.dropdown == Some(Dropdown::Thread)
                {
                    return s;
                }
                let Some(title) = self.source.list_threads().get(id).map(|t| t.title.clone())
                else {
                    return s;
                };
                // Centred on the row, kept inside the window: the tip must
                // not run past the bottom edge either.
                let max_top =
                    (f32::from(window.viewport_size().height) - THREAD_TIP_HEIGHT).max(0.);
                s.child(
                    div()
                        .absolute()
                        .left(px(theme::SIDEBAR + 8.))
                        .top(px((y - THREAD_TIP_HEIGHT / 2.).max(0.).min(max_top)))
                        .flex()
                        .items_center()
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(theme::px_token("radius", "radius-sm")))
                        .bg(color("raised"))
                        .shadow(theme::float_shadow())
                        .font_family(theme::FONT)
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(color("ink"))
                        .child(title),
                )
            })
            .when(self.stats_open, |s| s.child(crate::stats::render(self, cx)))
            .when(self.stats_tip, |s| {
                // To the right of the sidebar's Stats row: a window tooltip
                // here would flip up over the label, since the footer sits
                // at the window's edge. The footer is padding 8 with three
                // 30px rows; Stats is second.
                let top = f32::from(window.viewport_size().height) - 106. + 38.;
                s.child(
                    div()
                        .absolute()
                        .left(px(theme::SIDEBAR + 8.))
                        .top(px(top.max(0.)))
                        .flex()
                        .items_center()
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(theme::px_token("radius", "radius-sm")))
                        .bg(color("raised"))
                        .shadow(theme::float_shadow())
                        .font_family(theme::FONT)
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(color("ink"))
                        .child("Usage stats"),
                )
            })
            .into_any_element()
    }
}

#[cfg(all(test, feature = "render-harness"))]
mod tests {
    use super::{MockSource, Workspace};
    use gpui::{Entity, TestAppContext, VisualTestContext};

    fn mock_workspace(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut VisualTestContext) {
        cx.update(crate::composer::bind_keys);
        let source = MockSource::new().with_project_title("moxen-chat", "a  b");
        cx.add_window_view(|window, cx| Workspace::with_source(Box::new(source), false, window, cx))
    }

    #[gpui::test]
    fn the_new_thread_draft_hides_the_open_thread(cx: &mut TestAppContext) {
        let (workspace, cx) = mock_workspace(cx);
        cx.update(|_, cx| {
            workspace.update(cx, |w, cx| w.select(0, cx));
        });
        cx.run_until_parked();
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("status-usage").is_some());
        cx.update(|window, cx| {
            workspace.update(cx, |w, cx| w.new_thread(window, cx));
        });
        cx.run_until_parked();
        cx.update(|_, cx| {
            let w = workspace.read(cx);
            assert!(w.creating);
            // The sidebar, title bar and status line read the draft through
            // `shown_thread`: an active draft presents no thread, so the old
            // row, its state chip and its usage pill all clear.
            assert_eq!(Workspace::shown_thread(w.creating, w.selected), None);
        });
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("status-usage").is_none());
    }

    #[gpui::test]
    fn drafting_hides_the_inspector_and_reselecting_restores_it(cx: &mut TestAppContext) {
        let (workspace, cx) = mock_workspace(cx);
        cx.update(|_, cx| {
            workspace.update(cx, |w, cx| {
                w.set_inspector(true);
                w.tab = 2;
                w.select(0, cx);
            });
        });
        cx.run_until_parked();
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("inspector").is_some());
        cx.update(|window, cx| {
            workspace.update(cx, |w, cx| w.new_thread(window, cx));
        });
        cx.run_until_parked();
        cx.update(|_, cx| {
            let w = workspace.read(cx);
            assert!(w.creating);
            // The draft hides the old thread's inspector but keeps its
            // place: the tab and the open preference survive for the return.
            assert!(w.inspector_open);
            assert_eq!(w.tab, 2);
        });
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("inspector").is_none());
        cx.update(|_, cx| {
            workspace.update(cx, |w, cx| w.select(0, cx));
        });
        cx.run_until_parked();
        cx.update(|_, cx| {
            let w = workspace.read(cx);
            assert!(!w.creating);
            assert!(w.inspector_open);
            assert_eq!(w.tab, 2);
        });
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("inspector").is_some());
    }

    #[gpui::test]
    fn enter_on_an_empty_palette_does_not_activate_a_row(cx: &mut TestAppContext) {
        let (workspace, cx) = mock_workspace(cx);
        cx.update(|window, cx| {
            workspace.update(cx, |w, cx| w.open_palette(window, cx));
        });
        cx.simulate_keystrokes("enter");
        cx.update(|_, cx| {
            let w = workspace.read(cx);
            assert!(w.palette_open);
            assert!(w.thread_form.is_none());
            assert!(w.project_form.is_none());
        });

        cx.update(|_, cx| {
            workspace.read(cx).search.clone().update(cx, |search, cx| {
                search.set_text("Rename thread".into(), cx);
            });
        });
        cx.simulate_keystrokes("enter");
        cx.update(|_, cx| assert!(workspace.read(cx).thread_form.is_some()));
    }

    #[gpui::test]
    fn duplicate_project_rename_keeps_the_normalized_name_and_retry_clears_the_error(
        cx: &mut TestAppContext,
    ) {
        let (workspace, cx) = mock_workspace(cx);
        #[cfg(debug_assertions)]
        {
            cx.update(|_, cx| {
                workspace.update(cx, |w, cx| {
                    w.problem = Some("An earlier error".into());
                    cx.notify();
                });
            });
            cx.run_until_parked();
            assert!(cx.debug_bounds("composer-problem").is_some());
        }
        cx.update(|window, cx| {
            workspace.update(cx, |w, cx| {
                w.pick_project_action("moxen-agent", true, window, cx)
            });
            workspace
                .read(cx)
                .action_input
                .clone()
                .update(cx, |input, cx| {
                    input.set_text("  a   b  ".into(), cx);
                });
        });
        cx.simulate_keystrokes("enter");
        cx.update(|_, cx| {
            let w = workspace.read(cx);
            assert!(w.project_form.is_some());
            assert_eq!(w.action_input.read(cx).text(), "a b");
            assert_eq!(
                w.problem.as_deref(),
                Some("A project already exists with title \"a b\".")
            );
        });
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("composer-problem").is_none());

        cx.update(|_, cx| {
            workspace
                .read(cx)
                .action_input
                .clone()
                .update(cx, |input, cx| {
                    input.set_text("Unique project".into(), cx);
                });
        });
        cx.simulate_keystrokes("enter");
        cx.update(|_, cx| {
            let w = workspace.read(cx);
            assert!(w.project_form.is_none());
            assert!(w.problem.is_none());
            assert!(w.source.projects().iter().any(|project| {
                project.id == "moxen-agent" && project.title == "Unique project"
            }));
        });
        #[cfg(debug_assertions)]
        assert!(cx.debug_bounds("composer-problem").is_none());
    }
}
