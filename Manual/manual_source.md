---
title: RazorCAD User Manual
subtitle: Parametric parts, assemblies, sheet metal, structures and drawings
---

# Introduction

## What RazorCAD is

RazorCAD is a parametric part modeller for Windows with a classic feature-tree interface. You build a part as a **feature history**: sketches, extrudes, revolves, cuts, fillets, patterns and so on, each of which can be edited later. Changing a dimension or an equation rebuilds every feature after it. {idx:parametric modelling}

Solid modelling runs on the **OpenCascade** B-rep kernel (the engine behind FreeCAD), through the replicad library. Display uses three.js. RazorCAD runs fully offline. {idx:OpenCascade}

Main capabilities:

- Constraint-driven 2D sketches with relations, dimensions and equations, plus gear and airfoil generators
- 3D sketches for frames, pipe and duct routes and sweep paths
- Solid features: extrude, revolve, sweep, loft, hole, helix, threads, wrap, draft, rib, dome, patterns, mirror, fillet, chamfer, shell
- Multi-body parts with combine, subtract, split, move/copy, per-body materials and appearances
- Surface modelling: extruded, revolved, planar, lofted, swept, filled, boundary and ruled surfaces, trim, extend, knit, thicken and more
- Sheet metal: flanges, hems, miter flanges, sketched bends, jogs, forming tools, tab and slot, lofted bends, transitions, flat patterns and DXF export
- **Fast Structure** (weldments): structural members from standard profiles, end caps, gussets, weld beads and a cut list
- Assemblies with mates (including gear and rack-pinion mates), sub-assemblies, configurations, standard parts and fastener sets, equations shared with the parts, holes and cuts made in the assembly, exploded views, motion studies, collision detection, an interference check, a bill of materials with mass and cost, and STEP export
- 2D drawings of parts and assemblies, with projected, section, detail, auxiliary, broken, exploded and flat pattern views, dimensions (also made automatically), GD&T, cosmetic threads, balloons, bill-of-materials tables, a drawing check, DXF drawings placed on the sheet, and PDF and DXF export
- Millimetres or inches, chosen for each document
- STEP, IGES, STL, OBJ and 3MF import; STEP, STL, OBJ, 3MF and glTF export; DXF import into sketches and drawings, and DXF export of faces and flat patterns
- Macros, recorded or written, that drive RazorCAD
- English, German, French or Spanish, a light or dark theme, and keyboard use of the panels
- An **Ask Claude** panel that builds features from a plain-language description
- A browser version at razorcad.com/app, the same program without installing anything

## About this manual

This manual describes RazorCAD as it is in the version shown on the cover. It is checked against the software every day and updated when features change; Appendix C lists what changed in each revision.

The **Contents** and the **Index** are clickable. The footer of every page has a **Back to Contents** link. Your PDF viewer's bookmarks pane shows the same outline.

## Conventions

| Convention | Meaning |
|---|---|
| **File ▸ Save** | A menu command: the File menu, then Save |
| [[Ctrl+S]] | A key or key combination |
| **Property panel** | The panel on the left that holds a feature's settings while you edit it |
| **Feature tree** | The feature history list on the left |
| **Command ribbon** | The tabbed toolbar across the top (Features, Sketch, Surfaces …) |
| `width/2` | Text you type, such as a value or an equation |

> Note: Lengths are in **millimetres** or **inches**, chosen for each document (see Units). Angles are in **degrees**.

# Installing and Starting RazorCAD

## Running RazorCAD

Double-click **RazorCAD.exe**. It is one standalone program: it needs no browser, Python or installation, and it runs offline. It uses the Microsoft Edge WebView2 runtime, which comes with Windows 10 and 11. {idx:RazorCAD.exe}

## RazorCAD in your browser

**razorcad.com/app** runs the same RazorCAD in a web browser (Microsoft Edge, Chrome and other current browsers), with nothing to install: parts, sketches, assemblies, drawings and macros, on the same geometry kernel. {idx:browser version}

- **Open** reads a file from your PC and **Save** downloads it. Preferences stay in that browser.
- There is no auto-save, no Windows fonts (the fonts that come with RazorCAD are used) and no Ask Claude sign-in. A notice at the top says so and links to the Windows app; ✕ closes it for good.
- Parts that take a while to build are kept in the browser's own storage (up to 400 MB), so they open quickly the next time.
- Closing the browser tab with unsaved work asks first.

## Installing with the setup program

Testers can be given **RazorCAD-Setup.exe**, a single setup program with RazorCAD inside it. {idx:installer}

- Install for the current user (`%LOCALAPPDATA%\Programs\RazorCAD`, no administrator rights), for all users (Program Files), or into a folder you choose.
- Setup installs the Microsoft Edge WebView2 Runtime and .NET Framework 4.8 from Microsoft if they are missing.
- It creates Start-menu and desktop shortcuts and registers RazorCAD under Windows **Installed apps** with an uninstaller.
- The uninstaller asks before removing settings and crash reports. Part files are never touched.
- Running setup again updates an existing installation.
- Until RazorCAD is code-signed, Windows may show "Windows protected your PC" for the setup: click **More info**, then **Run anyway**. The *Read me first* file that comes with the setup says what to expect for that version.

Silent install and uninstall:

| Command | Effect |
|---|---|
| `RazorCAD-Setup.exe /S` | Silent install for the current user |
| `/D=folder` | Install into this folder |
| `/ALLUSERS` | Install for all users |
| `/NODESKTOP`, `/NOSTARTMENU` | Skip the desktop or Start-menu shortcut |
| `uninstall.exe /S` | Silent uninstall |

## Updates

A little after it starts (at most once a day), RazorCAD asks GitHub for the newest RazorCAD release. When there is a newer one, a notice in the corner offers **Download** (the release page), **Later** or **Skip this version**. Nothing is shown when you are up to date or offline. Only GitHub is asked; nothing about you or your parts is sent. {idx:updates}{idx:Check for Updates}

**Help ▸ Check for Updates…** checks at once and says what it found. Its window also turns the check at start on or off. **Help ▸ About RazorCAD** shows the version you have.

**Update Now** (in the notice and in Check for Updates) updates in one click: RazorCAD downloads the new setup from its GitHub release, checks it against the release (size and SHA-256), installs it into the same folder (asking for administrator rights only when it was installed for all users), closes and starts again as the new version. Unsaved work is saved first (**Save All and Update**), or the update waits. The helper waits for this installation's app and launcher processes to close, checks the installer result, verifies that the executable was replaced and that the installed version matches the download, then restarts. A failed installation shows an error and its log path instead of silently reopening the old version. A copy of RazorCAD that wasn't installed with the setup offers **Download** instead. {idx:Update Now}

If updating fails, inspect `%TEMP%\RazorCAD-update\update.log` and run the downloaded setup in that folder manually after closing RazorCAD. The helper script is saved beside it as `install-update.ps1`. Fixes to the updater itself take effect once a build containing them has been installed; an older installation may need the newer setup run manually once.

## The start window

At launch RazorCAD shows a start window with: {idx:start window}

- **New to RazorCAD? Take the one-minute tour** (until you have taken it; see Getting Started Tour)
- **New Part**, **New Assembly** and **New Drawing**
- **Open…**
- **Sample Part**, a ready-made part to explore
- **Recent Parts**: name, folder and date. Missing files are greyed out and can be removed with ✕. Parts that have an auto-save waiting are marked.
- **Recover Previous Session**, offered once when unsaved work from an earlier version is found
- A notice when new crash reports have been written

Reopen it any time with **File ▸ Recent Parts / Start…**.

## The RazorCAD window

| Area | What it does |
|---|---|
| **Menu bar** | File, Edit, View, Insert, Tools, Help. Next to the menus are quick buttons for **Save**, **Save As**, **Rebuild** and **Search commands** (the magnifier). |
| **Document tabs** | Each open part or drawing has its own tab. ✕ closes a tab and asks to save. |
| **Command ribbon** | Tabs of tool buttons: **Features**, **Sketch**, **Surfaces**, **Sheet Metal**, **Fast Structure**, **Evaluate** and **Claude**. Buttons with a shortcut show the key in their bottom-right corner. |
| **Feature tree** | The part's history, with folders for Solid Bodies, Sheet Metal Bodies and Surface Bodies, the material, the planes and every feature. An eye column on the right shows or hides each item. |
| **Configurations tab** | Next to the Feature tree and the Property panel at the top of the left panel (see the Configurations chapter) |
| **Property panel** | Opens in place of the tree while you create or edit a feature. ✔ accepts ([[Enter]]), ✕ cancels ([[Esc]]). |
| **Heads-up toolbar** | Above the 3D view: view orientation, display style, selection filters, visibility (eye button) and section view |
| **Confirm corner** | The top-right corner of the view holds ✔ / ✕ for the active feature or sketch |
| **Status line and progress bar** | Bottom left. Long operations (opening, rebuilding, importing, meshing, exporting) show progress here. The rebuild time is shown at the right; when features have errors it shows their number in red: click it for Fix References. |
| **Units** | Bottom right: **MMGS** (millimetres) or **IPS** (inches). Click it to change the document's units. |

{idx:Command ribbon}{idx:Feature tree}{idx:Property panel}{idx:heads-up toolbar}

## Customising the ribbon

The ribbon shows its buttons in two rows. {idx:toolbars, customising}

- **Icon size**: Small, Medium or Large, from **View ▸ Toolbar Icons** or by right-clicking the ribbon.
- **Rearrange**: drag a button to a new place; the others slide aside.
- **Your own toolbars**: click **+** after the tabs (or right-click a tab ▸ **New Toolbar…**). Add tools by dragging a button onto its tab or with right-click ▸ **Add to "…"**. Drag a button off to remove it.
- Right-click a button on a built-in toolbar to hide it or add a separator after it. **Customize Toolbars…** shows hidden buttons again, and **Reset** puts a toolbar back as it was.
- In **Customize Toolbars…**, choose **Sketch** and set **Sketch toolbar layout** to **Expanded (all tools)** or **Grouped (flyout menus)**. Grouped mode gathers lines, rectangles, arcs, splines and slots under split buttons. Click the main icon to start the last-used variant; click the adjacent arrow to choose another variant. The icon and label follow the saved choice. With a family tool active, its **Type** selector in the Property panel offers the same variants, in both toolbar layouts. Choices made with shortcuts or individual toolbar buttons are remembered too. Each family remembers its own variant between sessions. The layout preference is saved, and changing it preserves the expanded toolbar order and hidden tools. Use Expanded mode to rearrange individual tools.

The layout is kept in `prefs.json` in RazorCAD's data folder.

## Settings

**File ▸ Settings…** or **Tools ▸ Settings…** (in parts, assemblies and drawings) has everything you can set in one place; a change applies at once: {idx:settings}{idx:preferences}

- **Appearance**: theme, language, the size of the toolbar icons, and the Sketch toolbar's layout (all tools, or grouped in flyout menus).
- **Units and Axes**: the units of the part, assembly or drawing shown, and its up axis (also used for new parts).
- **Sheet Metal Gauges**: the gauges you saved (from a sheet metal feature's **Gauge** row, **Save…**); delete the ones you no longer want.
- **More Settings**: DXF Settings, Customize Shortcuts, Customize Toolbars, Claude Settings and the Getting Started Tour.

## Language and theme

- **View ▸ Language**: English, Deutsch, Français or Español, in parts, assemblies and drawings. The menus, ribbons, Property panels, dialog titles and buttons, the tree's fixed items and the start window are translated; longer help texts and messages are still in English. The command search finds a command by its translated name or its English one. Macros, recordings and your shortcuts work in every language, and files are the same in all of them. {idx:language}
- **View ▸ Theme**: Light, Dark, or Follow Windows (switches when Windows does). In the dark theme the window, the 3D view and sketches are dark; drawing sheets stay white paper. {idx:dark theme}{idx:theme}

Both are kept with your preferences.

## Getting Started Tour

A one-minute tour of the window in eight short steps, each pointing at its part of the window: the ribbon, the feature tree, the view and its mouse buttons, how to make a first part, the command search and the units. It ends with **Open the Sample Part**. Use **Next** / **Back** (or [[→]] / [[←]] and [[Enter]]); [[Esc]] or **Skip the tour** ends it. {idx:Getting Started Tour}{idx:tour}

The first time RazorCAD starts, the start window offers it. If you close the start window on an empty part, it starts by itself, once. Afterwards it is in **Help ▸ Getting Started Tour**.

## Search commands

Press [[Ctrl+K]] (or [[/]]), or click the magnifier next to Save, and type part of a command's name: "fil" finds Fillet, "circ pat" Circular Pattern. Pick a result with [[↑]] / [[↓]] and [[Enter]], or click it. {idx:command search}{idx:search commands}

- It searches every command of the menus and the ribbon of the document in front: part, sketch, 3D sketch, assembly or drawing.
- Each result shows where the command lives (its menu or ribbon tab) and its shortcut.
- With nothing typed, the commands you used lately come first.
- Sections of this manual about what you typed are listed after the commands (**Manual · ** and their chapter): pick one to read it in the manual panel.

## The manual in RazorCAD

This manual is built into RazorCAD. **Help ▸ User Manual**, the **?** at the top right of the window or [[F1]] opens it in a panel at the right of the window, beside the model; with a Property panel open, [[F1]] or the panel's **?** opens it at that feature. {idx:manual, in RazorCAD}{idx:help}{idx:F1}

- **Search**: type in the box at its top what you are looking for (a feature, a command, a word): the sections that have all the words are listed, the best first, with the words marked. Click one (or [[Enter]] for the first) to read it; the words are marked in it too. The arrows ‹ › go back and forward through what you read; with nothing typed it lists the chapters.
- **Wider or narrower**: drag its left edge. RazorCAD keeps the width for next time.
- **A window of its own**: **⧉** puts the manual in a window of its own, at the same place. Move it anywhere, onto another monitor too, and size it as you like; help you open while it is open shows there. **⇤** in that window puts it back in the panel; closing that window puts help back in the panel next time.
- **Close**: **✕** closes the panel. Your parts, assemblies and drawings stay open as they are; nothing is saved or closed with it.

## Your own keyboard shortcuts

**Help ▸ Customize Shortcuts…** (or **Customize…** in Help ▸ Keyboard Shortcuts) gives commands keys of your own. Find a command, click **Set** and press the keys, for example [[Ctrl+Shift+F]], [[G]] or [[F6]]. {idx:keyboard shortcuts, customising}{idx:shortcuts, your own}

- A shortcut works wherever its command is, in the document in front.
- It takes the place of a key RazorCAD uses itself; the window says when it does (for example [[F]], Zoom to Fit). Giving a key to another command moves it there.
- [[Esc]], [[Enter]], [[Tab]] and [[Backspace]] can't be used.
- ✕ removes a shortcut; **Remove All** removes them all. Your shortcuts are listed at the top of Help ▸ Keyboard Shortcuts and shown in the command search. They are kept in `prefs.json`.

## Using the keyboard

{idx:keyboard use}{idx:accessibility}

- **The trees**: click the feature tree, assembly tree or drawing tree, then [[↑]] / [[↓]] move from row to row (selecting as a click does), [[←]] / [[→]] close and open folders, [[Enter]] opens the item as a double-click does, and [[Home]] / [[End]] go to the first and last row. While the tree has the keyboard, the arrow keys don't turn the view; click the view to give them back.
- **Property panels**: [[Tab]] goes through a panel's fields and buttons. The group headings are buttons: [[Enter]] or [[Space]] opens or closes them. The small ✕ / ▲ buttons in lists can be pressed the same way. [[Enter]] on a focused button presses it; elsewhere in the panel it accepts the feature, as before.
- [[F6]] / [[Shift+F6]] move the keyboard focus round the window: the Property panel (or the tree), the ribbon, the view.
- **Dialogs** take the focus when they open (their first field), keep [[Tab]] inside, and give the focus back when they close.
- **Screen readers**: every panel field is named by its label and unit (for example "Depth (mm)"), fields with an invalid value are marked so, and icon-only buttons are named by their tooltips. The status bar and panel messages are read out as they change, and errors at once.

## Units

Each part, assembly and drawing is in **millimetres** or **inches**. Click **MMGS / IPS** at the right of the status bar, or use **Tools ▸ Units: Millimetres / Units: Inches**. Changing the units keeps every size exactly as it is; only how sizes are shown and typed changes. {idx:units}{idx:inches}{idx:millimetres}

In an inch document:

- Feature fields show and take inches. The arrow keys step 0.1 in ([[Shift]]: 1 in).
- Sketch dimensions, the Modify box and the sizes shown while drawing are in inches.
- Measure shows in, in² and in³; Mass Properties also gives the mass in pounds.
- New features start at round sizes, to the nearest 1/8 in.
- Equation variables used in a length count in inches: with `w = 3`, a depth of `w/2` is 1.5 in.

Any value can name its unit: `2in`, `30 mm`, `1.5cm`, `2ft`, `(w/2)*in`. Values typed before a document became inch keep their size; an expression typed in millimetres shows as `(…)*mm`.

Drawings have units of their own (see the Drawings chapter). A drawing made from an inch part starts in inches.

# Working with Files

## Part files

Parts are saved as **.rcad** files, assemblies as **.rasm**, drawings as **.rdrw** and drawing templates as **.rdrt** files (see the Assemblies and Drawings chapters). {idx:.rcad}{idx:.rasm}

| Command | Shortcut | Notes |
|---|---|---|
| **File ▸ New Part** | [[Ctrl+N]] | Opens in a new tab |
| **File ▸ New Assembly** | | Opens in a new tab |
| **File ▸ Open…** | [[Ctrl+O]] | Opens parts, assemblies, drawings, templates, and STEP, IGES, STL, OBJ and 3MF files |
| **File ▸ Open Sample Part** | | The built-in sample, in a new tab |
| **File ▸ Save** | [[Ctrl+S]] | Uses the normal Windows save dialog the first time |
| **File ▸ Save As…** | [[Ctrl+Shift+S]] | Saves a copy under a new name |
| **File ▸ Where Used…** | | The assemblies and drawings that use this part or assembly: those open now, and (once it is saved) those in its folder and the folders under it. **Open** opens one {idx:Where Used} |
| **File ▸ Revisions…** | | The revision history of the part or assembly: **New Revision** records the next revision (A, B … Z, AA; or the next number) with its date, description and who made it, sets the **Revision** property, and keeps a copy of the document as it is; **Open** opens that copy again as a new document {idx:revisions} |
| **File ▸ Properties…** | | The part's or assembly's custom properties (see below) |
| **File ▸ Compare With…** | | Compares the part with another version of it (see below) |

## Properties

**File ▸ Properties…** in a part or assembly holds custom properties such as Part Number, Description, Vendor, Finish or Cost. Common names are suggested; any name works. Undo takes a change back. A drawing of the part takes its drawing number from the Part Number, bills of materials can show any property as a column, and the **Cost** property gives the cost columns (see Bill of Materials). {idx:properties, custom}{idx:Part Number}

## Compare With

**File ▸ Compare With…** compares the part in front with its last saved version, another part file, or another open part. {idx:Compare With}

- **Features and settings**: features added or removed, features changed (with which settings: a depth, sketch points, an end condition, a new name), features moved in the tree, and the part's own settings (material, equations, units, configurations, properties).
- **Shapes**: both versions' volumes, and the material this version **adds** (shown yellow on the model) and **removes** (red), with their volumes.

## Tabs and closing

Several parts and drawings can be open at once, each in its own tab. New, Open and Sample all open a new tab. Closing a tab with unsaved changes asks whether to save it, and closing RazorCAD asks to save every unsaved part. {idx:tabs}

## Auto-save and recovery

Auto-save starts once a part has been saved for the first time. While the part has unsaved changes it is written next to the part file, at most every 20 seconds, as `Name.autosave.rcad`. The title bar shows the time of the last auto-save. Saving the part removes the auto-save file. {idx:auto-save}{idx:recovery}

If RazorCAD closes with unsaved changes, opening the part again offers to **recover** the auto-saved version. It is also marked in the recent list.

> Warning: A part that was never saved is not auto-saved. RazorCAD warns before closing it. Save new parts early.

The recent-files list is kept in `%APPDATA%\RazorCAD\recent.json`.

## Opening from Windows and file previews

Double-clicking a .rcad, .rasm or .rdrw file opens it in RazorCAD; if RazorCAD is already running, the file opens in a new tab there. RazorCAD sets the file types up itself when it starts. **Help ▸ Open Files With RazorCAD…** shows whether they are registered and can register them again. {idx:file associations}

Saving keeps a small picture of the view in the file. Windows Explorer, the Open and Save dialogs and the start window show it as the file's thumbnail. {idx:file previews}

A part that takes a while to build is stored, once built, in `%LOCALAPPDATA%\RazorCAD\modelcache` (kept under 1 GB). With it the kernel keeps the geometry after each feature. Opening the unchanged file again shows the model at once, ready to edit: the first change after opening rebuilds only from the changed feature on, as any later change does. The store is kept for each version of the geometry kernel, so it survives RazorCAD updates that leave the kernel alone. {idx:model cache}

Each open part keeps a geometry kernel of its own, as many as the PC's processor threads and free memory allow (see Speed on your PC in the Troubleshooting chapter). Switching back to a part is then immediate, and a part still building goes on while you work in another tab.

## Point clouds

**File ▸ Import Point Cloud (PLY, XYZ)…** {idx:point cloud}{idx:scan}{idx:PLY} brings a scan into the part as a **Point Cloud** feature, shown as dots: a PLY file (ASCII or binary; its faces are not read) or a text file of x y z lines (XYZ, TXT, CSV, PTS). Up to 200 000 points are kept (every so many of a bigger scan). **Surfaces ▸ Fit Surface to Points** {idx:Fit Surface to Points}{idx:reverse engineering} makes a surface body fitted to it by least squares: a **Plane**, a **Cylinder**, a **Sphere**, or a **Freeform** surface through a grid of heights over the cloud's best plane (more grid points follow it more closely). The message gives how far the points are from the surface (RMS and the largest). Build the part on the fitted surfaces with the usual tools (Thicken, Knit, Replace Face…).

## Importing STEP, IGES, STL, OBJ and 3MF

There are two ways to bring in a STEP, IGES, STL, OBJ or 3MF file: {idx:STEP, import}{idx:STL, import}{idx:OBJ}{idx:3MF}

- **File ▸ Open…** opens it as a part of its own in a new tab, named after the file, without asking. A STEP file that holds an assembly asks first: {idx:STEP, assembly}
  - **Open as an Assembly** makes a new assembly with the file's structure: a sub-assembly for each of its sub-assemblies, a part for each part, and a component, fixed, where the file places each one. Each part keeps its own piece of the STEP file and is built on its own, and a part used several times is built once. {idx:sub-assembly, from STEP}
  - The first build of each part is kept on disk (in `%LOCALAPPDATA%\RazorCAD\modelcache`, up to 1 GB, shared with parts). The next time the assembly opens, unchanged parts are shown straight from there instead of being rebuilt, so a big assembly reopens in seconds. {idx:assembly, opening quickly}
  - **Open as One Part** brings every solid into one part, as before.
- **File ▸ Import STEP / STL…** ([[Ctrl+I]], also on the Features tab, and **Import STEP / STL / OBJ / 3MF** on the Evaluate tab) offers three choices: a **new part**, **insert in place** into the current part, or **insert and locate with mates**. Locating with mates adds a separate "Locate …" Move Body feature under the import.

How imports behave:

- The file's contents are stored inside the part file, so the part does not depend on the original file.
- A STEP file's appearances come with it: the colour of each solid and of single faces, and transparency. Your own Appearance and Make Transparent / Make Opaque settings on a body win over them. {idx:appearance, imported}
- STEP imports as an exact solid. Every solid becomes its own body; a solid made of several separate shells is split into one body per shell; loose surfaces become surface bodies.
- The bodies of a multi-body STEP file are grouped in their own folder under Solid Bodies.
- Tick **Merge touching bodies into one body** in the import feature to fuse them instead.
- STL, OBJ and 3MF meshes are converted to a solid made of their triangles, with coplanar triangles merged. A 3MF file's units and build placement are read. A mesh that is not closed comes in as a surface body, with a note saying how many open edges it has; **Repair Mesh** or **Convert to Solid** (Surfaces chapter) can close it.
- Big meshes are simplified on import, by default to 80,000 triangles, keeping their edges and outlines. Set the limit in the import's properties (**Simplify meshes above … triangles**; 0 never simplifies). The import's note says how far a mesh was simplified. {idx:mesh simplification}
- Imported bodies can be cut, extended, patterned and (for STEP) filleted like any other body. A cut or fillet on a body of more than 20,000 mesh faces warns that it can take several minutes.

**IGES files** (.igs, .iges) open and import like STEP files. Trimmed and bounded surfaces, B-rep solids, B-spline, plane, revolved, extruded, cylinder, cone, sphere and torus surfaces, lines, arcs, B-spline and composite curves and polylines are read, with the file's units and transformations. Faces that close up are sewn into a solid; the rest come in as surface bodies. RazorCAD translates IGES into STEP for the geometry kernel, which has no IGES reader of its own. {idx:IGES}

Volumes of bodies with B-spline faces (imported NURBS, IGES) are measured exactly.

## Exporting

| Command | Result |
|---|---|
| **File ▸ Export ▸ STEP…** | An exact B-rep. Each body is written as its own named, coloured solid. |
| **File ▸ Export ▸ STL…** | A binary mesh |
| **File ▸ Export ▸ glTF (.glb)…** | The bodies as the view shows them, for web viewers and AR {idx:glTF}: each a mesh with its colour and its render look's metalness and roughness, in metres, Y up |
| Evaluate ▸ **Export OBJ** / **Export 3MF** | A mesh; 3MF is written in millimetres |
| Right-click a body ▸ **Export Body as STEP…** | One body only |
| **File ▸ Export ▸ Face as DXF…** | The outline of a flat face (see below) |
| **File ▸ Export ▸ Flat Pattern as DXF…**, Sheet Metal ▸ **Export DXF** | Flat patterns (see the Sheet Metal chapter) |
| Drawing ▸ **Export PDF** / **Export DXF** | Drawing sheets (see the Drawings chapter) |

{idx:STEP, export}{idx:STL, export}

### Export Face as DXF

Click a flat face, then right-click ▸ **Export Face as DXF…** (or **File ▸ Export ▸ Face as DXF…**). The face's outline (layer `OUTLINE`) and holes (layer `HOLES`) are written as a 2D drawing in millimetres, seen from outside the part. Use it for laser or waterjet cutting, or to take a profile into a 2D CAD program. {idx:DXF, face export}

Lines, arcs and circles are exact; other curves become fine polylines. The file is DXF R12, which practically every program can read.

# Navigating the 3D View

## Mouse and keyboard

| Action | Mouse / keys |
|---|---|
| Rotate (free, about the point under the cursor where the drag starts: a red dot shows it) | Middle-drag, or left-drag on the model outside a sketch |
| Pan | [[Shift]] + right-drag, or [[Ctrl]] + middle-drag |
| Zoom | Mouse wheel (toward the cursor), or [[Shift]] + middle-drag |
| Roll | [[Alt]] + middle-drag, or [[Alt]] + ← / → |
| Rotate in steps | Arrow keys 15°, [[Shift]] + arrows 90° |
| Pan in steps | [[Ctrl]] + arrow keys |
| Zoom to fit | [[F]] |
| Standard views | [[Ctrl+1]] … [[Ctrl+7]] |
| Normal To | [[Ctrl+8]] (press again to flip to the back side) |

{idx:rotate view}{idx:pan}{idx:zoom}

## Standard views

**View** menu: Front ([[Ctrl+1]]), Back ([[Ctrl+2]]), Left ([[Ctrl+3]]), Right ([[Ctrl+4]]), Top ([[Ctrl+5]]), Bottom ([[Ctrl+6]]), Isometric ([[Ctrl+7]]) and Trimetric. **Normal To** ([[Ctrl+8]]) looks straight at the selected face or plane. {idx:standard views}{idx:Normal To}

## Up axis: Y or Z

A part can be shown **Y up** (the default) or **Z up**: **View ▸ Up Axis**, right-click **Origin** in the feature tree, or click **Y up** / **Z up** at the right of the status bar. With Z up the **Top plane is XY**, the **Front plane XZ** and the **Right plane YZ**, and Z points up; the tree shows each standard plane's axes beside its name. The choice is kept with the part and used for new parts too. {idx:up axis}{idx:Z up}

Only the names of the axes change: the model stays where it is and no feature moves. The triad, X / Y / Z directions, Move / Copy Bodies, reference point coordinates, Measure, Mass Properties and 3D sketch coordinates all use the part's axes, and so do exported STEP, STL, OBJ and 3MF files: a part shown Z up is written Z up, and a file imported into it is read Z up. The origin and corner triad always show X in red, Y in green and Z in blue: the vertical axis is green with Y up and blue with Z up.

An **assembly** keeps its own up axis in the same way (View ▸ Up Axis, the status bar, or right-click its **Origin** in the tree; Undo takes it back). Its tree shows the standard planes' axes, and a STEP file exported from an assembly shown Z up is written Z up. A new assembly starts with the up axis used for new parts.

## Display styles

**View** menu or the heads-up toolbar: **Shaded With Edges**, **Shaded**, **Hidden Lines Removed** and **Wireframe**. {idx:display styles}

## Visibility

- **View ▸ Show / Hide Planes** toggles the standard planes.
- The **eye column** at the right of the Feature tree shows or hides each sketch, plane, axis, point, curve, body and body-making feature on its own. Hiding a feature hides the bodies it built. Planes, axes, points and curves can also be hidden one at a time with right-click ▸ **Hide**.
- The **eye button** on the heads-up toolbar (or **View ▸ Visibility…**) filters what is shown: sketches, axes, planes, points and surfaces, with select-all and deselect-all. {idx:visibility}
- Right-click a body (tree or view) ▸ **Hide**. [[Tab]] hides the body under the cursor; [[Shift+Tab]] shows the hidden body under the cursor.
- **View ▸ Show Hidden Bodies** shows hidden bodies so you can click them to show them again. Choose **Done Showing Hidden Bodies** to finish.
- Right-click a body ▸ **Isolate** hides everything else. The isolated body can still be edited. **View ▸ Exit Isolate** returns. {idx:isolate}
- Right-click a body, or any feature that made or changed it, ▸ **Make Transparent / Make Opaque**. Transparency is saved with the part and can be undone. {idx:transparency}

## Section view

**Tools ▸ Section View…** (or the Evaluate tab) cuts the model open on a plane so you can see inside. Choose the plane, an offset (equations are allowed) and flip the side kept. With a flat face, a plane or a sketch selected when you start, the cut starts on it; while the panel is open, click a flat face or a plane to cut from it instead. Drag the blue arrow on the cut to move it along its normal (the offset follows, in round steps; looking straight along it, drag up to bring it toward you). Tick **Section 2** (and **Section 3**) to cut with two or three planes at once: only what all of them cut away is removed, e.g. a quarter cut. The arrow and a click in the view move the section you changed last. It works the same in assemblies (Evaluate ▸ Section View): every component is cut and capped, and a click on a component's flat face cuts from it. ✓ keeps the cut on while you work; the Section View button then opens the panel again, and ✗ removes the cut. Saved with a cut on, a part or assembly opens with it again, and each tab keeps its own cut. Each cut body or component gets its own cap in its colour, outlined and hatched with section lines; the hatch angle and spacing change from body to body so touching parts read apart.  Section View can't be used inside a sketch. {idx:section view}

# Selecting

## Selecting in the part

A click selects what is under the cursor, in this order: a **vertex**, then an **edge**, then a **face**, then a **plane**. [[Ctrl]]+click adds to the selection. {idx:selection}

## Selection filters

The filter buttons on the heads-up toolbar limit what can be picked. Several filters can be on at once, and they also apply while picking references for features. {idx:selection filters}

| Filter | Key | Picks |
|---|---|---|
| Faces | [[X]] | Model faces |
| Edges | [[E]] | Model edges |
| Vertices | [[V]] | Corners (edge end points) |
| Solid Bodies | [[B]] | Whole bodies (a click on any face picks its body) |
| Planes | | Standard and reference planes |
| Clear filters | [[F5]] | Back to picking anything |

## Quick readout of sizes

Clicking an edge shows a small tag in the view: its length, R and length for an arc, or Ø and circumference for a circle. [[Ctrl]]+click more edges for their total length (the perimeter when they go all the way round). Sketch entities shown in the view can be clicked the same way. {idx:quick readout}

One face shows its area (and Ø when round). [[Ctrl]]+click a second face for how they lie: "Parallel · 12 mm apart", "Perpendicular · 90°" or the angle; two round faces give their centre distance; three or more faces their total area.

## Highlighting from the tree

Hovering a feature in the Feature tree highlights what it made in orange: the faces of a boss, cut, fillet, chamfer, shell, pattern or moved body; a sketch's curves; a plane, axis or point; a surface feature's surfaces. Clicking it keeps the highlight in blue while it is selected. {idx:highlight}

## Selecting hidden bodies

Hold [[Shift]] and **right-click** to step through the bodies and surfaces under the cursor, front to back; [[Shift]] + left-click steps back. The current one is shown in orange, through whatever is in front of it. Release [[Shift]] and **left-click** on the same spot to select it. [[Esc]] or a click elsewhere cancels. {idx:hidden bodies, selecting}

- With only the face filter on, or while a Property panel asks for faces (Shell, Offset Surface), it steps through faces instead.
- While a Property panel asks for bodies (Combine, Split, Move/Copy, Knit, Thicken), the click adds the body.

## Right-click menus

| Right-click on | Offers |
|---|---|
| A face | Sketch, Normal To, Export Face as DXF, Fillet, Chamfer, Appearance… |
| An edge | Fillet, Chamfer (started with that edge), Reference Axis |
| A vertex | Reference Point |
| A face, edge or body | Body Properties, Body Appearance…, Export Body as STEP, Hide, Isolate, Make Transparent, folder commands |
| A sketch in the tree | Edit, Show / Hide, Change Sketch Plane… |
| A sheet metal body | View Flat Pattern, Export Flat Pattern as DXF |
| Empty space | Show Hidden Bodies, Measure and view commands |

{idx:context menus}

# Sketching

## Starting and ending a sketch

Click a plane or a flat face, then click **Sketch** (Sketch tab), or right-click a face ▸ **Sketch**. Clicking a sketch tool such as **Circle** with no sketch open also starts a 2D sketch: pick a plane or flat face and the tool is ready. (For sketches in space, see the 3D Sketches chapter.) You can also start a feature such as Extrude without a sketch: RazorCAD asks you to pick a plane or face, you sketch, and when you exit the sketch the feature continues. If the profile is open you can keep editing or abort and keep the sketch. {idx:sketch, start}

- [[Esc]] ends the active sketch tool first; pressing it again closes the sketch and keeps it.
- [[Enter]] does **not** leave the sketch.
- The ✔ in the confirm corner, or **Exit Sketch**, closes the sketch.
- [[Ctrl+Z]] / [[Ctrl+Y]] undo and redo inside the sketch.

## The sketch tool wheel

While sketching, press and hold the right mouse button. After a moment, or as soon as you start to drag, a wheel of sketch tools appears around the pointer. Keep the button held, move toward a tool (it highlights) and release to activate it. Releasing in the centre or pressing [[Esc]] cancels. A quick right click (press and release without moving) still opens the right-click menu. {idx:tool wheel}

## Defined and under-defined sketches

Sketches are made of points, lines, arcs and circles held in place by **relations** and **dimensions**. A numerical constraint solver keeps them satisfied. {idx:fully defined}

- Geometry is **blue when under-defined** and **black when fully defined**.
- The Property panel shows the remaining degrees of freedom.
- An under-defined sketch shows **(-)** in the tree. Construction lines only need to be positioned. To rename a sketch, right-click its tree item and choose **Rename**, including when it has the **(-)** marker.

## Automatic relations

With **Automatic relations while sketching** enabled, Line and Centerline infer parallel or collinear directions from other lines in the active sketch, including construction and projected lines. The reference highlights orange and the cursor identifies the proposed relation. Click to create a persistent relation. Starting near a line's extension snaps onto its supporting line; continuing along it creates Collinear. Endpoint, midpoint and on-curve snaps retain priority. Direction inference uses a 4° angular tolerance and a 9-pixel proximity limit; spline control-polygon helpers are excluded. Turning automatic relations off disables these inferences.

## Sketch orientation

In the sketch Property panel, **Rotate 90°** turns the sketch axes about the sketch normal, and **Flip Side** looks at the sketch from the other side of the plane. Both are saved with the sketch. {idx:sketch orientation}

## Sketch tools

| Tool | Key | How it works |
|---|---|---|
| **Select** | [[S]] | Select entities, drag geometry |
| **Line** | [[L]] | Click a chain of points. Coincident, horizontal, vertical, parallel and collinear relations are inferred automatically; snapping to a midpoint or onto a curve adds those relations too. Double-click, [[Enter]] or [[Esc]] ends the chain. |
| **Centerline** | | Construction line for symmetry, mirroring, gears or as a revolve axis |
| **Midpoint Line** | | Midpoint, then one endpoint; the opposite endpoint is mirrored and a Midpoint relation preserves the centre |
| **Corner Rectangle** | [[R]] | Built with horizontal and vertical relations |
| **Center Rectangle** | | Also adds construction diagonals with a midpoint relation |
| **Circle** | [[C]] | Centre, then radius |
| **Centerpoint Arc** | [[A]] | Centre, start, end; the direction follows the mouse |
| **3 Point Arc** | | Start, end, then a point it runs through |
| **Tangent Arc** | | From the end of a line or arc, kept tangent by a Tangent relation |
| **Ellipse** | | Centre, end of the major axis, then the minor radius. Trim it for an elliptical arc. |
| **Fit Point Spline** | [[N]] | Through fit points, with editable tangent direction and strength handles; see below |
| **Point** | | Lone sketch points that stay, for example to place holes |
| **Straight Slot** | | Built with tangent and equal relations |
| **Center Point Slot** | | Slot midpoint, one end-arc centre, then width |
| **Overall Slot** | | Two outermost points along the axis define total length; the third click defines width |
| **Center Point Arc Slot** | | Centre of the path arc, start centre, end direction, then width |
| **3 Point Arc Slot** | | Start centre, end centre, third point on the centre arc, then width |
| **Polygon** | [[P]] | Set the number of sides in the Property panel |
| **Dimension** | [[D]] | See below |
| **Trim** | [[T]] | See below |
| **Extend** | | A line or arc end runs on to the first entity in its way and stays on it |
| **Split** | | Splits a line or arc in two at the click; the halves stay collinear or equal |
| **Project Edges** | [[E]] | See below |
| **Offset** | [[O]] | See below |
| **Mirror** | | Select the entities plus a centerline, then click Mirror |
| **Import DXF** | | See below |
| **Sketch Picture** | | A picture (PNG, JPEG, BMP, GIF or WebP) on the sketch plane, to trace over. See below |
| **Equation Curve** | | A spline through the points of **y = f(x)** (x from / to) or of **x = f(t), y = g(t)** (t from / to), in a number of **Pieces**. Part variables can be used and the curve follows them; sin, cos and tan take degrees. A parametric curve that ends where it starts is closed. An **Equation** relation holds it (it is fully defined); select it and use Equation Curve again to change it. {idx:equation curve} |
| **Linear Sketch Pattern** | | Opens a side panel with an orange preview. Select source entities before or after opening it, then choose an angle, line or curve as direction/path. Copies stay linked to their sources, path, quantity and spacing. Along a curve, spacing is measured along it and copies can rotate with it; open paths stop at their end. A straight direction also supports a second direction. |
| **Circular Sketch Pattern** | | Copies the selected entities with the relations and dimensions among them. A selected point is the pattern's centre. |
| **Make Block / Insert Block / Explode Block** | | Make Block saves the selection (with its relations) under a name in your settings. Insert Block places copies with a click, in any sketch, turned by an angle, and can delete blocks from the library. A **linked** copy (the default) moves and turns as one (a rigid Block relation holds it) and follows the block: Make Block again under the same name updates every copy in the sketch where it is, keeping relations from other geometry to it. Explode Block makes the selected copies plain geometry with the block's own relations and dimensions. Untick **Linked** for plain copies. |
| **Text** | | See below |
| **Gears** | | See the Gears chapter |
| **Airfoil** | | See the Airfoils chapter |
| **Sketch Fillet / Sketch Chamfer** | | Set the radius or distance, then click corners (a fillet: where two lines, a line and an arc, two arcs, or a fit-point spline and a line or an arc meet: the spline is cut back to the fillet, which stays tangent to it; a chamfer: two lines). The first one made gets the dimension; the others made before you leave the tool are made Equal to it, so one value changes them all. |
| **Intersection Curve** | | Click earlier sketch curves to create linked intersections with the active sketch plane, or select a model section |
| **Construction Geometry** | [[Q]] | Toggles selected curves to/from construction; with no curves selected, toggles construction mode for newly drawn geometry. The drawing panel also has **For construction**. Preview and resulting geometry are dashed and ignored by features. |
| **Display Relations** | | Shows or hides the relation glyphs |
| **Delete** | [[Del]] | Deletes the selected entities or relations |

{idx:sketch tools}{idx:Line tool}{idx:rectangle}{idx:circle}{idx:arc}{idx:ellipse}{idx:slot}{idx:polygon}{idx:Extend}{idx:Split, sketch}{idx:sketch pattern}{idx:blocks}{idx:construction geometry}{idx:Mirror}{idx:sketch fillet}

**Linear patterns and patterns along a path**: confirm with the checkmark, or cancel with the cross (Enter / Esc also work outside input fields). The preview does not change the sketch until confirmed. Use **Sketch Patterns ▸ Edit Pattern** in the sketch Property panel to change sources, path, count, spacing or rotation later; count and spacing accept expressions. Edit original geometry to change the copies' shapes. Copies are linked and cannot be independently dragged; deleting a source, path or generated entity removes that pattern's copies. Parameters and links are kept with the part and follow undo/redo and rebuilds.

Patterns made by earlier versions were independent copies and contain no stored pattern definition. Recreate them with the updated command to obtain a parametric pattern.

Pattern copies use the defined-geometry colour: black in the light theme and light in the dark theme. Purple identifies projected geometry; the pattern preview is orange.

Fillet corners can share one endpoint or have endpoints joined by Coincident relations. If exactly two regular lines/arcs meet at a corner, construction geometry there is ignored when choosing the curves to fillet. An invalid radius leaves the sketch unchanged.

## Dimension

Click a line, circle or arc (or two entities), then click to place the dimension. {idx:Dimension}

You can also select a curve or two entities before starting **Dimension**. Move the pointer to position the orange preview, then click to confirm; the dimension is not created until that click. Press **Esc** to cancel the pending dimension. The text is placed at the point you choose.

With **Select** or **Dimension** active, drag a dimension's number to reposition its annotation without changing the measured geometry or value. A plain click still opens the value editor. This also works for driven/reference dimensions; placement is saved with the sketch and follows undo/redo. Press **Esc** during a drag to cancel the move.

Linear dimension text follows the dimension line and stays upright. Extension lines leave a small gap at the geometry and run slightly beyond the dimension line; short dimensions use outside arrows. For a point-to-line distance, dragging the text also moves the perpendicular dimension line along the reference edge. This lets a short horizontal offset such as 4 mm and an inclined perpendicular offset such as 13 mm use conventional drafting layouts without changing what they measure.

- Moving the mouse switches between horizontal, vertical and aligned.
- Two lines give an angle; a point and a line give a perpendicular distance.
- Values accept equations, such as `width/2`.
- A dimension that would over-define the sketch is added as a driven (reference) dimension.
- **Circles and arcs:** dimension from a circle or arc to another circle, arc, point or line by clicking both. The Modify box offers **Center** (centre to centre), **Min** (nearest) and **Max** (farthest). Min also measures the gap between concentric circles. Switching keeps the geometry in place and shows the new value.
- **Outside references:** you can also click model edges, model vertices or entities of earlier sketches. RazorCAD creates linked construction geometry and dimensions to it, so the dimension follows the model. Example: "keep this hole 25 mm from the right edge" still holds after the width changes.

## Trim

Power trim: hover over a segment and it turns red; click to remove it up to the nearest intersections. Lines are shortened or split, circles become arcs, and new end points get on-curve relations. {idx:Trim}

## Offset

Click a line, arc, circle or spline, choose the options in the Property panel, then click to create its offset. **Select chain** switches between the clicked entity and its connected contour, including mixed line/arc/spline chains. Corners are re-trimmed or extended; an unjoinable or collapsed offset reports an error. {idx:Offset}

**Direction** offers **Pick side**, **Inside / left**, **Outside / right** and **Both sides**. Inside and outside follow the winding of a closed contour, including reversed contours. For an open chain they mean left and right along its traversal. Both sides places a copy at the specified distance on each side: one dimension drives both copies, so the total separation is twice the distance.

Enter **Distance** before creating the offset; expressions and parameters are supported. **Use mouse distance** lets the pointer set the initial distance instead. The resulting offset dimension can be edited later. Linked offsets retain their source references through save/reopen and follow source edits. Constrain the source geometry to hold it in place while changing dimensions.

Line and arc offsets remain analytic. Spline parallels are represented by cubic spline pieces, checked against source-curve normals at sampled parameters within **0.001 mm**; this is a sampled numerical check, not a certified global bound. Cusps, detected crossings and folds are rejected. A large source edit that exceeds the stored fit tolerance asks you to recreate that offset. Ellipses are not supported. Copies and blocks retain plain geometry rather than the offset link.

- You can also click a **model edge** (with **Select chain**, the connected edges lying in a plane parallel to the sketch, such as a face outline) or a curve of another sketch.
- **Linked offset** (default): the offset follows its source, including model edges when the model changes, and one dimension drives the chain (relation "Offset ⇉").
- Untick it for a **single offset**: plain geometry with no link.
- While the tool is active, the faces the sketch plane cuts are highlighted and the cut outline is drawn in teal. Clicking it offsets the whole outline.

## Project Edges

While editing a source sketch, sketches that depend on it are temporarily hidden to avoid displaying outdated projections over the current geometry. They return after leaving the sketch and rebuilding; independent reference sketches remain visible and the saved visibility settings are unchanged.

If a source edit such as a fillet separates formerly joined endpoints, their projected endpoints separate on rebuild while retaining their source links.

Splines projected from another sketch remain linked splines, preserving their control points, degree and weights. Earlier projections saved as line segments retain that representation.

Click a model edge, or an entity of an earlier sketch, to project it into this sketch. Or select edges first and then click **Project Edges** (or press [[E]]): they are projected at once. Projected geometry is drawn in **purple**, is linked and updates when the source changes (relation "On Edge ⇲"). The ends of projected lines are joined to each other and to sketch geometry already there, so the edges of a face give a closed outline ready to extrude. While the tool is active, the outline where the sketch plane cuts the bodies is drawn in teal; clicking it converts the whole outline. This works for solids and surfaces. {idx:Project Edges}

### Selecting source sketches for Project and Intersection

While editing a sketch, activate **Project Edges** or **Intersection Curve**. Earlier independent sketches are temporarily shown, including hidden and absorbed sketches; their saved visibility does not change. Click the source curves in the canvas (orbit the view if they overlap). Project creates linked projected geometry. Intersection creates linked points where source lines, arcs, circles or splines cross the active plane (a spline's crossings are solved on its exact curve, every one it makes); coplanar curves retain their geometry. Use the points as guide endpoints. For solid/surface sections, click the displayed section outline. Escape returns to Select.

**Projection Source → Source** can restrict picking to one earlier sketch or to model edges/sections. Choose the intended sketch when several sources overlap in the view. Other source sketches are temporarily hidden; leaving the tool restores their saved visibility. Source geometry is gray, while projected entities are purple. A visible source edge joining two projected sides is not automatically added to the active sketch.

## Spline

New **Fit Point Splines** include a tangent handle at each fit point. Drag a handle to change tangent direction and strength; adjacent pieces keep the same tangent through their shared fit point. Dragging a fit point carries its handle with it. Handle lines are construction geometry and accept ordinary line constraints and dimensions (for example horizontal, parallel, length or angle). Their remaining freedoms count towards sketch definition. Copies, mirrors, blocks, patterns and linked projections preserve the handles. Existing saved splines retain their previous representation.

Tangent handles are shown with solid teal stems, small direction arrows and round grips. Fit points use square markers. Selection names identify **Tangent Handle** and **Tangent Handle Line**, so these controls can be distinguished from ordinary construction centre lines.

Click the points the curve runs through (they snap like line points), then double-click, [[Enter]] or [[Esc]] to finish, or click the first point again to close it. Drag a point to reshape the curve, or drag the curve to move it; deleting a point takes it out of the spline. **Convert to Control-Point Spline** (in its panel) makes it a control-point spline that runs through the same points. Splines make profiles on their own or with lines and arcs and are exact curves for extrudes, revolves, cuts, lofts and sweep paths. Lines can be trimmed where they cross a spline. {idx:spline}

## Control-Point Spline

**Control-Point Spline** (beside Spline) draws a spline from control points: click them, then double-click, [[Enter]] or [[Esc]] to finish (click the first point again to close it: it then runs round smoothly, with no join). An open one starts and ends on the first and last control points and passes near the others; a closed one passes near them all. The **Closed** box in its panel opens or closes it. Choose the **degree** (1 to 7) in the panel before drawing, or select the spline afterwards to change it (at most one less than the control points): a higher degree is smoother and keeps farther from the polygon. {idx:selection box} The control polygon is drawn dashed and is made of construction lines, so you can dimension it and give it relations like any lines: horizontal, parallel, equal, an angle. The curve leaves each end along the polygon's end leg, so a relation on that leg (tangent to an arc, collinear with a line) sets its direction there. Drag the control points to reshape it. Deleting the spline deletes its polygon. {idx:control-point spline}{idx:spline, degree}

Select a control point for its own settings. **Weight** (1 is plain) pulls the curve toward that point when larger and lets it go farther when smaller: with three control points at the corners of a square, degree 2 and a weight of 0.7071 on the middle one, the curve is a quarter circle (to within 0.00001 mm). **Insert After** adds a control point half way along the next leg (the curve changes shape a little); **Remove**, or deleting the point, takes it out and joins its two legs. {idx:spline, weights}

## Import DXF

**Import DXF** brings a DXF file into the open sketch: lines, arcs, circles, polylines with arcs, ellipses and elliptical arcs, splines, points and blocks. The file's units are converted to millimetres. You can scale it and place it as in the file, centred, or by its corner. {idx:DXF, import}

**Sketch Picture** {idx:sketch picture}{idx:picture, tracing} puts a picture on the sketch plane behind the sketch, to trace over (a photo, a scan of a drawing). Set its width (the height follows), centre, angle, opacity, or hide it. To scale it by something of known size in it, draw a line along that, select the line, open Sketch Picture again, pick the picture and give the line's **true length**: the picture is scaled about the line's start. Pictures are shown while you edit the sketch, are saved in the part (shrunk to 2000 pixels across at most) and are not geometry: they make no faces and are not exported.

## Text

Click **Text** on the Sketch tab, then click to place. The panel sets the text, font (the PC's installed fonts, and the DejaVu Sans, Sans Mono and Serif fonts that come with RazorCAD), height (capital-letter height), angle, bold and italic. A font a PC doesn't have is drawn in the DejaVu font most like it. Drag the text to move it. Text extrudes as a boss or cut; text inside an outline is cut out of it. To put text on a curved face, use **Wrap** (Features chapter). {idx:text}

## Relations

Select entities ([[Ctrl]]+click for several, or drag a box from empty space: left to right selects what lies wholly inside it, right to left whatever it touches; [[Ctrl]] or [[Shift]] adds). The Property panel lists the relations that apply: {idx:relations}

| Selection | Relations offered |
|---|---|
| 1 line | Horizontal, Vertical, Fixed |
| 2 or more points | Coincident, Horizontal, Vertical |
| 2 or more lines | Parallel, Perpendicular, Collinear, Equal, Horizontal, Vertical |
| Point + line | Coincident (on line), Midpoint |
| Point + arc | Coincident (on curve), Midpoint (half way round the arc) |
| Point + circle | Coincident (on curve) |
| Line + circle/arc | Tangent |
| Line + open spline | Tangent at a spline endpoint (control-point or fit-point spline) |
| Circles/arcs | Equal Radius, Equal Curve Length, Concentric, Tangent |
| 2 or more curves (including splines, ellipses or mixed line/curve selections) | Equal Curve Length; for lines only, use Equal |
| 2 points + line | Symmetric (about the line) |
| 3 lines | Symmetric (two lines about a centerline) |

Relations are shown as small green glyphs next to the geometry. Click a glyph to select it, then press [[Del]] to remove it. Hovering a glyph highlights the entities it ties together. For several selected entities, relations already implied by existing constraints are skipped while useful relations are added. A relation refused says why: one that is **already satisfied** names the relations that already define the geometry that way (an information message); one that **would over-define** the sketch names the relations or dimensions in its way. Either way those relations are selected, so you can delete one and add the new relation instead. A true conflict rejects the entire request without changing the sketch.

**Tangent with a spline:** Ctrl-select a line and an open spline, then choose **Tangent**. The shared endpoint, or otherwise the spline endpoint closest to the infinite line, is used. To choose explicitly (required if both ends are equally close), also select the desired spline endpoint. The selected endpoint is stored and does not switch after edits. For control-point splines the first or last control-polygon leg is aligned with the line; fit-point splines use their endpoint tangent. Coincidence is separate: add Coincident between endpoints or Coincident (on line) to make the curves meet. Closed splines and zero-length endpoint directions are unsupported.

**Equal Curve Length (≋)** constrains the length measured along each selected curve, not its chord or control polygon. Two arcs may have different radii and sweeps while keeping equal lengths; a spline can also match a line or another curve. Select the curves with Ctrl and choose **Equal Curve Length** in **Add Relations**. With more than two curves, each is matched to the first. Circular curves' **Equal Radius (=)** keeps their radii equal and remains a separate relation. Length links survive source edits, undo/redo, save/reopen and rebuild. Ellipse and spline lengths are integrated numerically from their definitions.

## How profiles are found

Profiles are found automatically from all non-construction geometry and sent to the kernel as exact lines, arcs and circles. Intersections are split, dangling lines are ignored and nested loops become holes. A full circle (or arcs that make one) becomes a single closed curve, so an extruded circle has one continuous cylindrical face. {idx:profiles}

For canvas region selection, connected lines, arcs and splines can divide a closed outline into separate selectable cells within the same sketch. Click inside the desired cell; shared boundary edges may belong to several cells. Holes remain attached to their enclosing cell and can also be selected as disks. New cell references preserve boundary direction so regions sharing the same source curve IDs remain distinct. Existing whole-sketch and saved outline selections retain their previous extent. Construction geometry does not subdivide regions.

## Showing and hiding sketches

Sketches absorbed by a feature are hidden by default. Right-click a sketch in the tree ▸ **Show / Hide**, or use its eye in the tree. {idx:sketch, show/hide}

## Change Sketch Plane

Right-click a sketch ▸ **Change Sketch Plane…** and pick another plane or flat face for it, for example to repair a sketch whose plane was deleted ("The reference plane is missing"). Its curves keep their sketch coordinates. Only planes above the sketch in the tree are offered. {idx:Change Sketch Plane}

# 3D Sketches

A **3D sketch** holds lines, arcs, circles and splines in space rather than on one plane. Use it for frames (see the Fast Structure chapter), pipe, duct and wiring routes, and sweep paths. {idx:3D sketch}

## Starting and ending a 3D sketch

Click **3D Sketch** on the Sketch tab or the Fast Structure tab (or **Insert ▸ 3D Sketch**). The sketch opens empty with the Line tool ready; there is no plane to pick. While it is open the **3D Sketch** button stays highlighted and the first button becomes **Exit 3D Sketch**. Tools that only work in 2D sketches are greyed out. [[Ctrl+Z]] / [[Ctrl+Y]] undo and redo inside the sketch.

## Drawing in space

- Click points to draw lines. A line snaps along **X, Y or Z** from the last point whenever the mouse moves along that direction on screen, in any view. A dashed line shows it and an Along X/Y/Z relation is added. Hold [[Ctrl]] or [[Shift]] to draw freely.
- Away from the axes, lines follow the **drawing plane** through the last point. [[Tab]] cycles XY → YZ → ZX; the plane's name shows at the cursor. {idx:drawing plane}
- [[Ctrl]]+click a plane or flat face, or click a plane in the tree, to draw on it. Points placed there get an **On Plane** relation. [[Tab]] or [[Esc]] goes back to XY / YZ / ZX.
- Points snap, in this order, to the sketch's own points, to line and arc midpoints (Midpoint relation), to a point along a line (On Line relation), to the origin and model vertices, along X/Y/Z, then to the drawing plane.
- The **Next Point** box in the Property panel takes exact offsets, for example `0, 0, 250`.
- A selected point shows its X, Y and Z; type new values to move it. A selected line shows its length, ΔX/ΔY/ΔZ and end points; an arc its radius, angle and length.

## 3D sketch tools

| Tool | Key | How it works |
|---|---|---|
| **Line** | [[L]] | As above |
| **Centerline** | | Construction lines that shape the sketch (for example a frame envelope) but make no curve |
| **Point** | | A lone point |
| **Circle**, **Centerpoint Arc**, **3 Point Arc**, **Polygon** | [[C]], [[A]], [[P]] | Drawn on the active drawing plane through the first click. [[Tab]] changes the plane before or between clicks. A polygon stays regular. |
| **Tangent Arc** | | Click the free end of a line, arc or spline, then where the arc ends. Keep clicking for more arcs; [[Esc]] ends. |
| **Spline** | [[N]] | Click the points it runs through; double-click or [[Enter]] ends it, clicking the first point closes it. A Tangent relation with a line at an end makes it leave the line smoothly. Select a spline to set its **Shape**: tangent-smooth (C1) or **curvature-continuous (C2)**, whose curvature runs on smoothly through every point; and its **end weights** (how strongly the end tangents pull; more leaves the ends straighter). **Show curvature** draws curvature combs on the splines. |
| **Sketch Fillet / Sketch Chamfer** | | Click a corner where two lines meet. The sharp corner stays as a point on both lines, so lengths measured to it keep their meaning. |
| **Trim** | [[T]] | Click the piece to remove, up to where other entities cross or touch it |
| **Project Edges** | [[E]] | Click model edges to bring them in, linked to the model (see below) |
| **Dimension** | [[D]] | Length, distance between points, angle between lines, arc radius, circle diameter. While placing a length, [[Tab]] cycles true length → ΔX → ΔY → ΔZ. |
| **Construction Geometry** | [[Q]] | Toggles the selected lines to or from construction |
| **Delete** | [[Del]] | Deletes the selection |

{idx:3D sketch, tools}

**Move / Copy / Rotate**: drag a selected line, arc or circle to move the selection (it snaps along X, Y and Z), or type ΔX/ΔY/ΔZ and click **Move** or **Copy**, or rotate about X, Y, Z or the drawing plane's normal with **Rotate** or **Copy Rotated**. Copies keep the relations among the copied geometry. Fixed and projected geometry stays put.

## Relations in 3D

Along X/Y/Z, Parallel, Perpendicular, Collinear, Equal Length, Equal Radius, Tangent, Midpoint, On Line, Parallel to XY / YZ / ZX, On XY / YZ / ZX plane, On Plane, Regular Polygon, Fix and Merge (coincident). A solver keeps everything held and reports **Fully defined** or the degrees of freedom left. A relation or dimension that conflicts is refused with a message. {idx:3D sketch, relations}

## Projected edges in 3D

**Project Edges** brings model edges into the 3D sketch: lines stay lines, circular edges become arcs or circles and other curves become splines, with shared corner points. The geometry (purple) stays linked to the model: when the part changes, it follows the edges, and lines and dimensions attached to it follow too. **Unlink from the Model** in the Property panel makes it ordinary geometry.

## Curves from a 3D sketch

Each connected run of lines, arcs and splines is one curve; a T-junction splits it into separate runs. A run can be used as straight segments with an optional bend radius at the corners (pipe and duct routes) or as a smooth spline, and can be closed into a loop. **Sweep**, **Swept Surface**, **Lofted Surface**, **Curve Driven Pattern** and **Structural Member** use 3D sketches.

# Gears

RazorCAD's **Gears** tool on the Sketch tab draws involute gear trains as closed profiles, ready to extrude. {idx:gears}{idx:involute gear}

## Creating a gear train

1. Draw lines between the gear centres (centerlines work well).
2. Select the lines (or a single point for one gear) and click **Gears**. If you are not in a sketch, RazorCAD opens the selected sketch (or starts one) and asks you to click the centre lines, then press [[Enter]] or **Make Gears**.
3. Each line end point becomes a gear. Neighbouring gears mesh along the line, and teeth are turned automatically so they mesh.
4. Extrude the sketch: each gear becomes its own body.

Gear numbers are shown on the gears in the sketch (view labels only, not geometry).

## The Gear Train panel

Click a gear to open it.

| Setting | Meaning |
|---|---|
| Module and pressure angle | The tooth size and shape for the whole train |
| Teeth per gear, or ratio per mesh | Setting a ratio sets the next gear's teeth. Changing teeth or a ratio changes the centre-line lengths to suit, including your own length dimensions on those lines. |
| Backlash, tip/root clearance | Tolerances for prototyping and 3D printing |
| Bore diameter | The centre hole |
| Turn | Rotates the first gear |
| Set the line lengths to the mesh distance | Adds driving dimensions so the gears mesh exactly; each mesh shows ✔ or how far off it is |

## Rules for a valid train

Centres must be exactly at the mesh distance, gears must not overlap and each gear needs at least 6 teeth. Fixed line lengths get a module and teeth that fit. Edits that would break a train are refused. A broken train is drawn red with a **Fit gears to the lines** button and can't be extruded.

# Airfoils

The **Airfoil** tool on the Sketch tab draws a wing or blade section on a line. {idx:airfoil}{idx:NACA}

## Drawing an airfoil

1. Select a line in a sketch and click **Airfoil** (or click **Airfoil**, then the line).
2. The line becomes the **chord**: a construction line with the leading edge at its start. The airfoil is drawn on it.
3. The airfoil follows the line. Drag its ends or dimension it (or set **Chord length** in the panel) and the airfoil scales and turns with it.
4. Extrude the sketch. The profile is one smooth closed curve that follows the exact section to within 0.002 % of the chord.

## Sections

| Choice | Sections |
|---|---|
| Library | 28 NACA 4-digit sections (0006 to 6412), 10 NACA 5-digit sections (21012 to 25012, and the reflexed 23112), and Clark Y (11.7 %, 8, 10 and 14 %) |
| NACA code | Type any code, for example `4415` or `23012` |
| Custom | 4-digit: maximum camber, its position and thickness. 5-digit: design lift coefficient, camber position, reflexed camber line and thickness. Clark Y: thickness. Decimals are allowed. |

Options: sharp or blunt trailing edge, camber to the other side, and the leading edge at the other end of the line.

# Tutorial: a Guided Loft and a Sheet Metal Tray

This tutorial builds a small duct and a tray with tools added in the 0.17 versions: the closed control-point spline, a plane placed with **Placement**, a loft that follows a guide curve, a variable fillet with a point along its edge, and edge flanges that meet corner to corner. The finished part is in **File ▸ Open Example Part (Tutorial)** (also on the start window): open it to look round, or follow the steps in a new part. {idx:tutorial}{idx:example part}

## The bottom profile

1. Select the **Top Plane** and click **Sketch**.
2. Click **Control-Point Spline** on the Sketch tab and click eight control points round the origin, roughly at (50, 0), (40, 25), (0, 30), (−40, 25), (−50, 0), (−40, −25), (0, −30) and (40, −25). Click the first point again to close it: the curve runs round smoothly, near the points rather than through them.
3. Select the spline: its panel shows the **Degree** (3) and the **Closed** box. Select a control point to see its **Weight**; leave it at 1 for now. Drag a control point and the curve follows.
4. Exit the sketch.

## A plane, moved and turned

1. Click **Reference Plane**, pick the **Top Plane** and set the offset to 100.
2. Under **Placement**, set **Turn its axes in the plane** to 30°: the plane's axes turn in the plane, so whatever is sketched on it turns with them.
3. Sketch a circle of radius 20 at the origin on this plane and exit the sketch.

## The guide curve

1. Sketch on the **Front Plane**. With **Control-Point Spline**, click three points: the first where the bottom profile crosses the X axis (about 46.67, 0), one out to the side (about 62, 45) and the last on the circle (20, 100). Finish with a double-click or [[Enter]].
2. A guide curve has to touch every profile. The first point lies on the bottom profile's curve, not on a control point: with these control points the curve crosses the axis at 140/3 = 46.6667 mm (select the point and type 46.6667 for its X in the panel).

## The guided loft

1. Click **Loft**, pick the bottom sketch and then the circle's sketch as the profiles.
2. Under **Guide Curves**, pick the guide sketch. The loft's side follows the guide between the two profiles, and the profiles stay exactly as drawn. The note reads "2 profiles, 1 guide curve".

## A fillet with a point along its edge

1. Click **Fillet**, set the type to **Variable size** and **Radius** to **At vertices and points along edges**, and click the loft's bottom edge where the guide starts.
2. Set the radius to 3: that is the radius at the edge's vertices.
3. Under **Points along the edges**, click **Add Point**: half way along the edge (50 %) with a radius of 8. The point is marked on the edge; the fillet swells smoothly from 3 at the vertices to 8 there.

## The tray

1. Sketch an 80 × 60 rectangle on the **Top Plane**, beside the duct, and click **Base Flange** on the Sheet Metal tab with a thickness of 1.5 mm.
2. Click **Edge Flange** and pick the four top edges, with a length of 20. Under **Corners**, **Corner to corner** is the default: where two flanges meet, each runs on up to the other's inside face and ends square, the gap apart, and the bends end in a small V cutout. **Mitred** would close them on the diagonal, and **Overlap** would run one flange past the other's end.
3. Click **Flatten** to see the tray laid out, with its bend lines.

> Tip: change any value in the tree (the spline's degree, a weight, the plane's turn, the fillet's point) and the part rebuilds from there.

# Solid Features

## Live previews

While a feature's Property panel is open, the model is rolled back to just before that feature and the feature is shown in colour: **yellow** for material it adds and **red** (seen through the body) for material it removes. Fillets and chamfers show the material they add or remove; reference geometry being edited is drawn in orange. Click ✔ (or [[Enter]]) to finish. {idx:preview}

Every value field accepts numbers or equations (see Equations in the Evaluate chapter).

## Extrude and Extrude Cut

**Profiles** uses the same canvas selector as Loft. Click inside a closed region or on its contour to add it; click it again or use its remove button to deselect it. Select several coplanar profiles to extrude them together, including profiles from different sketches. Clicking a sketch in the tree selects its whole profile, including text and generated outlines. Picking an individual region afterwards replaces that whole-sketch selection. Nested regions can be selected separately, so you can extrude a ring or just the disk inside its hole.

**Model faces as profiles**: click a flat face of the model (where no sketch profile is under the cursor) to use the face itself as a profile, holes and all, without drawing a sketch on it; click it again to remove it. A face profile lies in the face's plane and extrudes out of its body (tick **Reverse direction** to go into it, for a cut). It can be combined with sketch profiles in the same plane and takes every end condition, the draft and every operation; it cannot be a Thin Feature. If the face changes when earlier features change, the profile follows it. {idx:face profile}

**Chain selection** selects connected curves. Turn it off to pick individual segments, then choose **Add selected contour** or press Enter; Escape clears the unfinished selection. Open contours enable **Thin Feature**. Turn off **Select profiles in canvas** to pick end references or target bodies; choosing an up-to end condition also switches to reference picking. Existing whole-sketch extrusions continue to build as before.

Extrudes a sketch profile into a solid, or cuts it out. {idx:extrude}{idx:Extrude Cut}

**Start** and **End** are independent. **Start from → Profile plane** preserves the usual extrusion. **Offset from profile** translates the starting plane by a signed distance along the first selected profile's normal; expressions are supported. **Plane / planar face** projects the profiles along the extrusion direction onto the underlying plane of the selected reference, including inclined planes. Use **Pick start surface in canvas** or the Start surface list. End references have their own picker and do not replace the start reference.

Blind depth, symmetric and two-sided distances are measured from the new start. Reversing the extrusion changes its extent direction while preserving the start offset. With an inclined start and a distance end, both caps follow the starting plane, separated along the extrusion direction. **Up To Surface**, **Offset From Surface** and **Up To Vertex** retain independent end references. Crossing boundaries, zero thickness and a starting plane parallel to the extrusion direction are rejected. The options apply to solid extrusions, cuts, Thin Feature and selected profile regions; saved start-plane references follow source edits. Surface Extrude retains its existing start behavior.

End conditions:

| End condition | Meaning |
|---|---|
| Blind | A set depth |
| Mid Plane | The total depth split equally on both sides of the sketch |
| Two sides | Independent Depth and Second depth on opposite sides of the profile plane |
| Through All / Through All – Both | Through every body, in one or both directions |
| Up To Vertex | Click a model vertex or choose a reference point |
| Up To Surface | Click a flat model face or choose a plane; angled surfaces are supported and the extrusion is trimmed to the surface |
| Offset From Surface | As Up To Surface, at a set distance from it |

**Second Side**: with a one-sided end condition (Blind, Through All, Up To Vertex, Up To Surface or Offset From Surface), tick **Second side** to extrude the other way from the start as well, to an end of its own: Blind (its own Depth), Through All, Up To Vertex, Up To Surface or Offset From Surface, with its own vertex or surface picker (**Pick second side surface in canvas**). The second side always goes the opposite way to the first: an end of the second side that lies on the first side's side of the profile is refused. Both sides share the start, the operation and the Thin Feature; the draft is shared too (each side drafted away from the profile) unless **Second side drafted on its own** is ticked (see Draft). Mid Plane, Two sides and Through All – Both already reach both ways and do not offer it. {idx:second side (extrude)}

Options:

- **Operation**: **Join** merges with existing material where possible; **New body** keeps the result separate; **Cut** removes material; **Intersect** keeps only the material inside the extrusion. A Join that does not touch existing material makes a new body. An Intersect changes each body the extrusion overlaps and leaves the others as they are; with **Feature Scope** limited to chosen bodies, a chosen body it does not overlap is removed. An Intersect that overlaps no body is refused, and an Intersect feature cannot be patterned or mirrored. {idx:Intersect}
- **Thin Feature**: makes a wall of the given thickness from the profile; direction one side, other side or mid-plane. Open sketches switch it on automatically. {idx:thin feature}
- **Draft**: tilts the walls by the **Draft angle**, about the plane the extrusion starts from: the solid narrows away from the profile, or widens with **Draft outward**. The walls of holes in the profile tilt the other way with them, so the material keeps one taper (a cut narrows as it goes in). Mid Plane, Two sides, Through All – Both and a second side draft each side away from the profile. Up To and Offset From an angled surface take the draft too: the walls tilt about the profile and the angled end is trimmed with them. From an angled start surface the walls tilt about the start surface, so the profile's outline is kept where the extrusion starts. If the walls would meet before the end, the draft is refused. With a second side, or with Two sides, **Second side drafted on its own** gives the second side (the Second depth) a **Second side draft angle** of its own, inward or (**Second side drafted outward**) outward; 0 leaves it straight. {idx:draft (extrude)}
- **Feature Scope** (cuts and intersects): **All bodies** by default; untick it and click the bodies to cut or intersect. {idx:feature scope}

## Revolve and Revolve Cut

**Profiles** uses the common canvas selector: choose regions, connected contours or individual entities rather than automatically consuming a whole multi-profile sketch. A flat model face can be a profile too, as for Extrude; its axis must then be a reference axis, a model edge or face, or a line of a sketch (a face has no sketch axes). Coplanar selections can be combined. Whole-sketch selection remains available explicitly and older files remain compatible.

Choose **Select axis in canvas** separately from the profiles. The axis may be a sketch axis, a line in an earlier sketch (including construction geometry), a reference axis, a straight/circular model edge or a cylindrical face. **Project axis into profile plane** projects its origin and direction onto the selected profile plane; a perpendicular axis cannot be projected. Return to **Select profiles in canvas** to edit the profile selection.

**Extent** is **Full (360°)**, **Angle**, **Up To Vertex** or **Up To Surface**. Up To Vertex turns the profile round the axis until it reaches the vertex (click a model vertex, or choose a reference point); Up To Surface until it reaches a plane or flat face. A plane through the axis stops the revolution at whichever half of it comes first; another plane or face trims the revolution where it crosses it, keeping what lies on the profile's side. **Reverse direction** turns the other way round. A vertex on the axis, a surface through the profile and a surface the revolution never reaches are refused (a profile touching the axis needs an end plane through the axis). Surface Revolve goes up to them too. Angle supports **One side**, **Two sides** with independent angles, or **Symmetric** (the total angle split equally). Reverse exchanges the signed direction for one/two sides. The total angle must not exceed 360°. Profiles must not cross a coplanar rotation axis. Full ignores stored angle values. Older files whose angles were clamped to 360° keep that geometry and migrate to Full when edited.

**Operation** offers Join, New body, Cut or Intersect (as for Extrude; Sweep and Loft offer the same). **Thin Feature** revolves a wall along open or closed contours; open contours enable it automatically. Cuts have the same **Feature Scope** as Extrude; **Select target bodies in canvas** switches explicitly from profile/axis selection to target-body picking. {idx:revolve}

## Sweep and Sweep Cut

Sweeps a profile along a path. {idx:sweep}

- **Profile**: a selected sketch region or contour, or **Circular** with a diameter (useful for springs).
- **Path**: a selected sketch chain, 3D sketch, curve or helix; or, under **Path from Model Edges → Select model edges**, edges of the model joined end to end into one chain (open or closed, without branches). A chain of model edges is followed from its end in the profile's plane. {idx:sweep, model edge path}
- **Orientation**: **Perpendicular to path** keeps the section square to the path; **Parallel to initial profile** moves it along the path without turning it (tight bends can make the sweep invalid); **Square to faces it runs on** keeps the profile's plane through the normal of the faces chosen with **Select faces in canvas**, for a path that lies on them (a groove round a curved part). {idx:sweep, orientation}
- **Twist angle** (with Perpendicular): the profile turns by this total angle along the path, by distance: **Twist → Evenly along the path**, or **Eased in and out** (slowly at both ends, fastest half way). Positive angles turn by the right-hand rule along the path. Equations are allowed; 0 is the usual sweep. A twist needs an open path with no sharp corners (round them first), and the profile in the plane square to the path at its start. {idx:sweep, twist}
- **End scale** (without a guide): the profile grows or shrinks about the path from its own size at the start to End scale times it at the end, by the length along the path, evenly or (**Scale → Eased in and out**) slowly at both ends; 1 keeps its size. It works with every orientation and with a twist. Checked against the volumes integrated along a line and an arc to 1e-7. {idx:sweep, scale}
- **Guide (optional)**: a second curve (sketch chain, 3D sketch, curve or helix) the profile follows. It replaces Orientation and Twist; removing it brings them back. {idx:sweep, guide curve}
  - **Guide controls → Orientation**: the profile turns to keep facing the guide and keeps its size. The guide doesn't have to touch the profile.
  - **Guide controls → Section size**: the profile is scaled evenly so its edge stays on the guide. The guide starts on the profile's edge and crosses each plane square to the path once.
  - A guided sweep takes one closed profile without holes or Thin, an open path and an open guide. Both curves run between the planes square to the path at its ends, and don't touch. A guide drawn the other way round is turned automatically. Contact with the guide is checked to 0.0001 mm; geometry that doesn't fit gives an error rather than an ordinary sweep.
- **Thin** option (without a guide).

**Select Profile / Path / Guide in canvas** activates one role at a time. Click inside a closed profile or on its contour; click path and guide curves directly. Each role has its own **Chain selection** checkbox. Turn it off to pick individual connected entities from one sketch, then choose **Use selected contour** or press Enter. Add or clear an unfinished contour before switching roles. Paths and guides may include construction curves. Different contours from the same sketch can be used in different roles, but the same entities cannot be reused across roles. Unrelated sketch geometry is ignored by selected contour references; missing selected curves report an error. **Other sources (whole sketch / curve)** retains explicit whole-sketch and supported derived-curve selection, including existing files.

Solid Sweep uses the same **Join / New body / Cut** operation control as Extrude and Revolve. Cut supports explicit target-body selection. Without a guide, selected regions retain internal holes and open profiles can use Thin Feature.

## Loft and Loft Cut

Blends between two or more section profiles, in order. A third or later profile shapes the middle. {idx:loft}

Activate **Select profiles in canvas**, then click a sketch contour or inside a closed region. Multiple regions in one sketch can be selected independently; holes belong to their enclosing region. **Select guides in canvas** switches to guide selection, including construction curves. Source sketches are temporarily shown while selecting, without changing their saved visibility.

**Chain selection** picks connected curves automatically. Turn it off to select individual segments from one sketch, then choose **Add selected contour** or press Enter. Escape clears an unfinished selection. Profiles and guides have separate ordered lists with move and remove controls, matching numbered highlights in the canvas. **Other sources** retains whole-sketch and supported 3D curve selection. Stored contour references follow source curve IDs through edits and renaming; missing or ambiguous boundaries report an error. Surface Loft uses the same contour selection for open or closed sections.

Guide contacts are checked against the actual CAD profiles. The fit uses the original guide curves and refines intermediate sections until sampled distances to the CAD faces are within **0.01 mm**. If this check fails, the feature reports an error: add a section near a tight bend. These are sampled numerical checks, not a guarantee over every point of the continuous curve. Thin lofts retain the wall's offset from the sketched guide.

**Guide construction → CAD constraints (two profiles)** builds patches constrained directly by the original 3D guide edges. It checks the kernel's contact error and independent distances against **0.0001 mm**. This method currently requires two profiles without Thin Feature, with guides starting and ending on corresponding patches. Holes in the profiles are lofted between them without the guides (each hole's sections joined directly) and cut out of the guided outline; they must stay inside it. **Across guide seams** selects C0 (contact, the default), G1 (tangent joins) or G2 (curvature-continuous joins along shared guides). Original profile corners are preserved. Unsupported or incompatible constraints report an error without falling back to approximation. **Adaptive approximation** remains available for the broader set of loft options and is the default for existing features.

### Profile correspondence

Enable **Edit profile connectors** to display numbered connections between matching profile vertices. Use **Pick start in canvas**, choose a start vertex in the panel, or drag a connector endpoint to another existing vertex on that profile. Moving an attachment shifts the correspondence around the contour while preserving boundary order. For circles, set the seam angle (expressions are supported) or drag the seam in the canvas. Open surface profiles use their endpoints; reversing their direction exchanges the endpoints.

Settings follow the selected profile through renaming, reordering, save/reopen and source edits. A deleted attachment reports an error and must be reselected. Use a profile's **Automatic for this profile** button to clear its settings, or reset all connectors to return to automatic matching. Closed profiles must share the same traversal direction: reversing only some would fold the loft. Manual matching is passed to the CAD builder without automatic remapping and also applies when guides or endpoint conditions are used.

Manual connectors support sketch profiles. **Start vertex → Inside a curve…** (or dragging a connector onto a curve between vertices) starts the profile at a point inside one of its curves, **Along it** a share of the curve's length in its own direction (expressions allowed): the profile gains a point there, without splitting the sketch, so a triangle can be lofted to a square by starting the triangle inside one of its edges. Every profile must end up with the same number of points. {idx:loft, connector inside a curve}

Profiles with holes list each hole: **Hole 1**, **Hole 2**… choose which of this profile's holes goes with the other profiles' hole of that number (pair them by hand when the automatic pairing joins the wrong ones), and **Hole … start** sets where each hole starts (a vertex, inside a curve, or a seam angle for a circle), as for the outline. {idx:loft, holes paired by hand}

Thin lofts take the connectors too: each wall starts at its vertex nearest the profile's start. 3D curve profiles use automatic matching. **More connectors**: after a profile's start vertex, **Add connector** adds another vertex to pair (Connector 2, 3…), so profiles with different numbers of corners can be matched corner to corner as you choose (a square's four corners to four of a hexagon's six). Every profile needs the same number of connectors, in the same order round it; between two connectors, the profile with fewer sides has its longest ones halved until the sides pair one to one. Connectors in a different order round one profile would make the loft's sides cross, and are refused. Surface Loft uses the same controls.

### Start and end conditions

**Start Condition** and **End Condition** control the first and last section independently:

- **Free** preserves the usual loft when both ends are free.
- **Normal to profile** makes the longitudinal endpoint derivative normal to its planar sketch.
- **Direction** uses a world axis or a reference axis. Create a reference axis from a sketch line for an inclined direction.
- **Tangent to adjacent faces (G1)** matches the tangent planes of existing solid or surface faces along the endpoint profile. Click **Select start support faces** or **Select end support faces**, then click the adjacent side faces in the canvas. Select all faces needed to cover the outer and inner profile edges, including Thin walls: one cylindrical face can cover a circle; a rectangular extrusion needs its four side faces. For a hollow section also select the adjacent inner walls. The profile must coincide with their boundary, not merely lie inside a face. Click **Select profiles in canvas** to return to contour selection.

**Curvature to adjacent faces (G2)** also matches the curvature of the selected adjacent faces. Set this independently at either end, including G2 at both ends or a G1/G2 combination. It uses the same support-face selection rules as G1. Curvature is measured on the CAD surfaces, including the along-edge, across-edge and mixed components; incompatible geometry reports an error. A sampled CAD normal check also rejects detected local collapses between profiles; reduce Influence or add a section if this happens. This does not certify the absence of every possible self-intersection.

**Influence** is a positive multiplier of the endpoint derivative length; 1 uses the distance to the neighboring profile as the scale. Larger values extend the endpoint's influence farther into the loft. Expressions are supported. **Reverse tangent direction** reverses the signed derivative and may create an invalid or overlapping loft.

Endpoint conditions require matching profile curve counts and a smooth loft. Solid lofts support **internal holes and Thin Feature**, including Outside, Inside and Mid-plane sketch offsets and open Thin profiles. Every section must have the same number of corresponding inner loops. Outer and inner walls are constructed together and sewn to end faces with openings, rather than filling the cavities. G1 and G2 support selection must cover all walls. They support two or more sections, and closed profiles for solids or open/closed profiles for surfaces. Intermediate sections use C2 cubic interpolation. Normal to profile requires a planar sketch; Direction also supports curve sources in Surface Loft. Closed surface profiles stay uncapped.

**Guide curves with endpoint conditions** use **Adaptive approximation**. Guides must meet every section in order, and their endpoint tangents must agree with the requested tangent planes and direction. Conflicting constraints report an error. Refinement uses 8/16/32/64/128 intermediate stations per profile interval and checks independent native guide points against the final CAD side faces to **0.0001 mm**. With Thin, guide checks retain the sketched outline’s offset to the outer wall; inner loops follow the guide deformation. Multiple guide deformations blend smoothly between contact locations (C2 blend weights), preserving physical profile corners. Influence remains relative to the original neighboring section, independently of the refinement count. **CAD constraints** with C0/G1/G2 guide seams still requires free endpoint conditions; selecting it with endpoint constraints gives an explicit error instead of switching methods.

The kernel constructs clamped tensor B-splines (cubic, or degree five along the loft when G2 is requested), refining profile interpolation from 8 through 128 intervals. It checks off-node profile contact and endpoint derivatives, including influence and direction. Final sewn CAD faces are checked again at 33 positions per endpoint for contact within **0.0001 mm**, tangent-plane mismatch within **0.5°**, and relative endpoint derivative error within **0.0001**. These are sampled numerical checks, not a certified global bound. Unsupported or incompatible constraints report an error without dropping the endpoint conditions. G2 additionally compares all three components of the second fundamental form on the final CAD faces, with curvature mismatch at most **0.001 1/mm**. Feature notes report measured contact, angular and G2 curvature errors.

- A circle is split into as many equal arcs as the other profile has corners.
- Profiles with different segment counts give an error naming the sketches.
- Options: straight (ruled) sides, Thin. Without straight sides: **Through the profiles** curvature-continuous (C2) or tangent-continuous (C1), and **Smooth the surface**, which evens out its bends. {idx:loft, continuity}
- **Guide Curves** (optional): curves the loft's outline follows between the profiles, such as a body's outline seen from the side. Each runs from the first profile to the last, through every profile, and is a selected chain of sketch curves or a supported curve source. Separate guides can come from the same sketch. One guide pulls the loft along it; two or more shape it round the outline, each where it touches the profiles. The profiles themselves are kept as drawn. Holes in the profiles, and a thin loft's inside, move with the outline, so a thin wall keeps its thickness; for a thin loft, draw the guide on the sketched line. {idx:loft, guide curves}

## Hole

**Hole** (Features tab, **Insert ▸ Features ▸ Hole…**) makes standard holes. {idx:Hole}{idx:counterbore}{idx:countersink}{idx:tapped hole}

| Type | Sizes |
|---|---|
| Hole (clearance) | ISO 273 close, normal or loose fit, for M2 to M24 |
| Counterbore | For socket head cap screws (ISO 4762) |
| Countersink | ISO 10642, 90° |
| Tapped hole | ISO metric or Unified (inch), drilled at the tap drill size; the thread is shown as a cosmetic thread and given in drawing callouts |
| Counterdrill | A wider drill (standard sizes: the counterbore's diameter and depth) with a drill point of its own angle down to the hole |
| Slot | Two half circles of the hole's diameter joined: **Slot length** between their centres, **Slot angle** from the face's X direction |
| Custom sizes | Your own diameters and depths |

- **End**: **Blind** (with a **Drill point** of **Drill point angle**, 118° unless set), **Through All**, **Up To Next** (each hole until its axis first comes out of the material: through the wall it starts in), **Up To Vertex**, **Up To Surface** and **Offset From Surface** (a plane or flat face, picked in the canvas or chosen in the list; each hole's own depth along its axis); reversible. {idx:Hole, end conditions}
- **Far-side countersink** (Through All, Up To Next): a countersink of its own diameter and angle where the hole comes out (the far side of the first wall for Up To Next, of the last for Through All). {idx:Hole, far-side countersink}
- Place holes at clicked points on a face, or exactly at the points and circle centres of a sketch on the face. On a curved face (a shaft, a pipe) a hole is drilled square to the face where it was clicked: a radial hole. {idx:Hole, on a curved face}
- Holes work on sheet metal too, and a drawing's **Hole Callout** reads their size from the feature.

## Helix

Pick a sketch with a circle; it sets the axis and diameter. Define the helix by **pitch and revolutions**, **pitch and height**, or **height and revolutions**. Options: start angle, clockwise, reverse. Use a helix as a sweep path for springs and coils. {idx:helix}

## Thread Cut and Thread Extrude

Click a bore (Thread Cut) or a shaft (Thread Extrude). {idx:threads}

- The size is chosen automatically from the diameter, or choose a **metric** (ISO) or **inch** (Unified) standard size, or custom. Coarse / UNC sizes are preferred.
- Optional pitch; **left-hand** option.
- Length: the whole face, a depth, or up to a plane or face. Threads never reach past the ends of their face.
- The bore or shaft is resized to the thread size if needed (a bore to the minor diameter, a shaft to the major). A bore that would break out of the body is refused.
- Threads run all the way to the ends: grooves run out into open air, otherwise the thread is cut off flush with the end.

## Cosmetic Thread

**Cosmetic Thread** (Features tab, **Insert ▸ Features ▸ Cosmetic Thread…**) marks a bore or shaft as threaded without modelling the thread, so it costs nothing to rebuild. Use it where the thread only needs to be shown and called out. {idx:Cosmetic Thread}{idx:threads, cosmetic}

- Click the bore (internal thread) or the shaft (external thread). The thread starts at the end nearest the click; **Start from the other end** reverses it.
- Size, pitch, left-hand and length (whole face, depth, or up to a plane or face) as for Thread Cut. The feature's note says when the face is not the size the thread expects (a bore about the minor diameter, a shaft the major).
- In the model it shows as a thin helix on the face. Tapped holes made with the Hole feature show their threads the same way.
- On drawings it is drawn by convention: from the side, thin lines at the thread's other diameter and a line where it ends, dashed for a hidden bore; end on, a three-quarter circle. A view's **Cosmetic threads** box turns them off.
- **Hole Callout** on a bore with a cosmetic thread gives the thread, for example "M10×1.5 THRU ALL / TAP DRILL Ø8.5 THRU ALL".

## Wrap (Emboss / Deboss)

Pick a sketch (outlines and/or text) and a face, flat or curved. The sketch is projected along its normal onto the face and raised (emboss) or sunk (deboss) by the depth. {idx:wrap}{idx:emboss}

## Patterns and Mirror

Patterns and mirrors copy features or bodies. Any feature that changes the bodies at a place can be copied: extrudes, cuts, holes, fillets, chamfers, drafts, domes and sheet metal forms. A feature without a shape of its own (such as a fillet) is run again on the matching edges or faces of each copy. {idx:pattern}{idx:mirror}

| Feature | Copies |
|---|---|
| **Linear Pattern** | Along one or two directions (X, Y, Z or any reference axis) |
| **Circular Pattern** | Round an axis (X, Y, Z or any reference axis) |
| **Mirror** | About a plane or flat face |
| **Sketch Driven Pattern** | At every point (or circle centre) of a sketch |
| **Curve Driven Pattern** | Along a sketch, 3D sketch or helix, spaced evenly to the end or at a set distance; moved, or turned to follow the curve |
| **Table Driven Pattern** | A copy for each row of a table: **x, y** from the feature along a plane's directions (the feature's own sketch plane when none is chosen) and optionally an **angle** turning the copy about the plane's normal through the feature. Rows are separated by `;` or new lines, cells by commas, tabs or spaces, so a table pasted from a spreadsheet works (a header row is skipped); cells can be sums or use variables |
| **Fill Pattern** | On a square or staggered grid over a flat face, kept a margin from its edges (for example a perforated panel) |

{idx:Sketch Driven Pattern}{idx:Curve Driven Pattern}{idx:Table Driven Pattern}{idx:Fill Pattern}

**Linear Pattern options** {idx:Linear Pattern, options}: **Distance → From the first to the last** spreads the instances over a total length instead of setting the spacing between each two. **Spacing grows by** makes each spacing that much more than the one before (a negative value: less), for copies that spread out or close up. **Symmetric** adds as many again the other way from the feature. With a second direction, **Pattern the feature only** copies just the feature along it, not the whole first row (an L of copies).

**Circular Pattern options** {idx:Circular Pattern, options}: **Angle grows by** (without equal spacing) makes each angle between copies that much more than the one before. **Symmetric** adds as many again the other way round (less than a whole turn). **Rings** makes rings of copies further out from the axis, **Ring spacing** apart, out through the feature's middle.

**Instances to Skip** (Linear and Circular) {idx:pattern, skip instances}: instance numbers to leave out, separated by commas: 1 is the feature, 2 the first copy, -2 the first copy the other way (symmetric). With a second direction or rings, row.column: 3.2 is the third along the first direction (or round) in the second row (or ring).

**What to copy.** Choose the **Feature**, and add any number of **More features**: each is copied the same way. In a Linear, Circular, Sketch Driven or Curve Driven Pattern, **Clicking the model picks** either **Faces**, where each face brings the feature that made it (click a hole's wall to copy the hole), or **Bodies**, which are copied whole to every place as new bodies. Mirror takes bodies too (tick them, or click them on the model). Fill Pattern copies features only. {idx:pattern, of bodies}{idx:pattern, of faces}

**Feature folders.** Right-click a feature ▸ **Add to New Folder…** (or **Move to** a folder already there, or **Remove from Folder**) to group features in the tree; a folder sits where its first feature is, with its features under it. Right-click a folder to rename it, delete it (its features stay), or make a **Linear** or **Circular Pattern of the Folder**. A pattern's **More features** list takes folders too: it copies whatever is in the folder each time it rebuilds, so a feature added to the folder later is copied as well. {idx:folder, features}{idx:pattern, of a folder}

**Library features.** {idx:library features} Right-click a feature or a feature folder ▸ **Save as Library Feature…** to keep it under a name in your settings, for any part: the feature with the sketches it uses (and, for a folder, everything in it), and the variables its sizes use. **Features ▸ Library Feature** puts it in the part you are in: choose it, set its variables (each copy gets variables of its own: a second copy's `w` becomes `w_2`), the angle to turn it about the face's normal, then click the plane or flat face for its first sketch. The copy goes into a folder of its name, and its features stay ordinary features you can edit. A feature that uses a plane, a body or projected geometry outside the group cannot be saved this way (put that in the group too).

Patterns of cuts are cut out in one operation, and patterns of added features (bosses, pins, ribs) are fused into the body in one operation, so large patterns rebuild quickly. A plate with 200 bosses builds in about 2 seconds.

A pattern or mirror of a sheet metal feature that makes a body (Base-Flange, SM-Extrude, Lofted-Bend, Transition) copies that body as it is at the pattern, with the flanges and cuts added to it so far. Each copy is sheet metal with its own flat pattern. A mirrored copy's flat pattern is the mirror image, with its bends going the other way. A mirrored lofted bend becomes a plain solid. {idx:pattern, sheet metal}

## Fillet

Open the feature and click edges on the model. The model is rolled back to just before the feature so every edge can be picked; tick **Preview** to see the result. The radius accepts equations. {idx:fillet}

- Edges are remembered by type, direction and position, and found again after parameter changes.
- Where a fillet can't be added on top of earlier fillets (a corner where several blends meet), RazorCAD recomputes it together with the preceding fillets in one operation.
- Where two blends exactly meet (for example R2 on both edges of a 4 mm wall) the result is a full round.
- **Variable size**: a radius at the start and another at the end of each edge, or **Radius ▸ At vertices and points along edges**: the panel lists the vertices of the selected edges (the ends of each run of edges) with a radius for each; empty ones use the fillet's radius. Along each edge the radius changes from the one at its start to the one at its end.
- **Points along the edges** (with radii at the vertices): **Add Point**, then choose the edge, where along it (the share of its length from its start in %, or a distance from its start in mm) and the radius there; or **Add by Clicking** and click on the edge where the point goes. The radius runs smoothly from the edge's start through its points to its end. While the fillet is edited each point is marked on its edge, so you can see which end the % counts from; **drag a mark** along its edge to move the point (its % or mm follows, and the fillet rebuilds when you let go). {idx:fillet, variable radius}
- **Setback at corners**: where three or more fillets meet, the corner is blended smoothly from this distance out, instead of the usual small corner patch. A little more than the radius works well; 0 keeps the usual corner. The fillet's note says how many corners were blended. {idx:fillet, setback}
- **Face fillet**: pick faces instead of edges; the edges where they meet are rounded.
- **Full round** {idx:fillet, full round}: click a side face, the face to round off, then the other side face (flat and parallel: a wall of even thickness). The middle face is replaced by one round meeting both sides, its radius half the wall's thickness.
- **Size by → Chord width** (constant size) {idx:fillet, chord width}: the value is the width across each fillet, from edge to edge; each edge's radius follows from how far its two faces turn (measured at its middle: exact between flat faces).
- **Shape → Curvature continuous (G2)** (constant size) {idx:fillet, G2}{idx:curvature continuous fillet}: instead of a round (which meets the faces beside it in tangent but jumps from flat to curved), each blend leaves its faces with the same tangent plane *and* no curvature, then curves gradually: no visible line where it starts, as on styled housings and covers. It sets back from the edge as far as the round of that radius would, but stays closer to the sharp corner, so it takes less material away. The blend is exact (a curve of degree five swept along the edge, not a fitted patch). It is made on straight edges between flat faces whose ends meet flat faces, and on circular edges all the way round between a flat face and a round face on the same axis (the foot or top rim of a boss, a counterbore's edge: the section revolved round the axis); round corners and other curved edges in a fillet of their own. The note reports the tangent and curvature mismatch measured on the CAD faces. For a G2 patch over an opening use **Filled Surface** with Boundary continuity **Curvature (G2)**; for G2 joins between lofted profiles use **Loft → Across guide seams → G2**.
- **An edge's own size** {idx:fillet, edge radius}: each edge in the list has a box for a radius of its own (expressions allowed); blank uses the fillet's. One feature can so round edges with different radii in one go, corners and all.
- **Add a face's edges**: then click a face, and all its edges are added (clicked again, removed).

## Chamfer

Click edges as for a fillet. Chamfer types: **equal distance**, **distance + angle** or **two distances**. **Flip direction** swaps the sides. With equal distances each edge can have a distance of its own, and **Add a face's edges** works as for Fillet. {idx:chamfer}

**Vertex (cut off a corner)** {idx:chamfer, vertex}: click corners of the model where three straight edges meet; each is cut off by the plane through the points the distance along each of its edges. **Different distances along X, Y and Z** gives the edges running most along X, Y and Z their own distances. A distance as long as its edge, or a corner in a recess (where the cut would add material), is refused.

## Shell

Click the faces to remove and set the wall thickness, inward or outward. With no faces removed, the body is **hollowed**: a closed void inside, the thickness in from the outside everywhere (a body too thin for it is refused). Hollowed **outward**, the body itself becomes the void and the walls are built round it, the thickness out from every face (edges and corners rounded). {idx:shell, hollow}

**Walls of Their Own Thickness** {idx:shell, wall thickness}: **Select walls in canvas**, then click flat faces of the body: each wall gets a thickness of its own, more than the shell's (the box beside it). Inward, the material behind the face is kept down to that depth; outward, the face is built out to that thickness over its own outline. A removed face cannot have one (it is the opening). Shell validates the resulting solid and rejects a failed offset that merely returns the original full body. For inward shells, small fillets or chamfers can be retained outside with sharp corners inside; the feature note reports this construction. If no valid cavity can be made, reduce the thickness, select different removal faces, or place Shell before the fillets and chamfers. {idx:shell}

## Draft

Pick a neutral face, then the faces to tilt by an angle. **Reverse** tilts them the other way. {idx:draft}

## Rib

An open sketch line is thickened and filled out until it meets the model, either in the sketch plane (for example a gusset across a bracket corner) or square to it. {idx:rib}

## Dome

A spherical cap or half ellipsoid on round faces, or a smooth dome filled over any other flat outline. **Reverse** presses it in. {idx:dome}

## Plastic part features

Four features for moulded parts (Features tab). {idx:plastic features}

- **Mounting Boss** {idx:Mounting Boss}: posts at clicked points on a flat face (or at a sketch's points and circle centres), rising out of the face: **Outer diameter**, **Height**, a **Draft on the outside**, a **Hole** (diameter, and a depth: empty for the full height), and **Ribs**: how many, their width, how far out from the boss and how high.
- **Snap Hook** {idx:Snap Hook}: a cantilever beam (**length**, **thickness**, **width**) with a hook at its tip: its **overhang**, its **lead-in angle** from the beam (the slope it slides in on) and its **catch angle** (90°: square, holding; less: it lets go when pulled). **Hook faces** turns it about the face's normal.
- **Lip / Groove** {idx:Lip / Groove}: click the flat rim face along the open edge of a shelled part: a **lip** (raised) or **groove** (sunk), along its **inner** or **outer** edge, of a width and height (depth). For two halves that fit: a lip on one, on the other a groove a little wider and deeper.
- **Vent** {idx:Vent}: slots across a sketch's closed outline on a face, of a **slot width** with **bars** between them, at an angle, kept a **margin** in from the outline, cut through or to a depth.

## Core and Cavity

**Core and Cavity** (Features tab) makes the two halves of a simple mould for the part {idx:Core and Cavity}{idx:mould}: a block round it (**Block margin** beyond it every way), the part taken out of it grown by the **Shrinkage** (the plastic shrinks as it cools), split at a parting plane square to the **Pull direction**. The plane goes at the part's largest section along the pull (or **At a height up the part**). The half the pull direction points into is the **Cavity**, the other the **Core**; holes along the pull become shut-offs where the plane crosses them. **Parting** can also be **a parting surface** of your own (a surface body reaching past the block all round, made with the surface tools along the part's parting line): the block is split by it, the side the pull points into the cavity. Check the part with Draft Analysis and Undercut Check first.

**Side Core** {idx:side core}{idx:slide, mould} (after Core and Cavity) makes a side action for an undercut: click its faces on the part (a side hole, a catch) and the direction it is pulled (the first face's normal, or an axis). A block round the faces (grown by the margin), from the part out past the mould block, is taken out of the core and the cavity and made a body of its own, **Side core**.

**Sprue and Runners** {idx:runners}{idx:sprue} cuts round runners along the lines of a sketch on the parting plane (half in the core, half in the cavity; they gate into the part where they meet it) and a tapered sprue from the back of the cavity down to the start of the first line.

## Move Face

Push or pull flat faces along their normal, or turn a face about one of its edges. The neighbouring faces follow. {idx:Move Face}

## Delete or Resize Fillet, Defeature

These edit a solid directly, with no history needed: good for imported parts. {idx:Delete Fillet}{idx:Resize Fillet}{idx:direct editing}

**Delete / Resize Fillet** (Surfaces tab): click fillet or chamfer faces. **Delete** carries the faces either side on until they meet at a sharp edge again; **Resize** then rounds (or chamfers) that edge at the **New radius**. The faces round them are grown or shrunk to close the gap exactly, so it works on most rounds and chamfers, including rounds that run into other rounds at a corner; the message says what the faces were (R2, chamfered, blended). When the faces cannot close the gap, it falls back to the simpler way: rounds along straight edges between flat faces (convex or concave), full rounds on circular edges (between a flat face and a round face, like the foot or top rim of a boss) and chamfers between flat faces, whose ends meet flat faces.

**Defeature** {idx:Defeature} takes every fillet up to a radius and every hole up to a diameter out of a body (or of every solid), for a simpler part to send to a supplier or to analyse. A hole is filled with its counterbore, countersink and drill point; one whose counterbore is wider than the limit stays whole. They are all taken out at once, exactly, the faces round them grown or shrunk to close the gaps (the message then says "taken out exactly"). If the kernel cannot close a gap, the body is done the simpler way, one at a time, and fillets whose ends do not meet flat faces, and holes that break out of the side of the part, stay; the message says how many were taken out.

## Scale

Scales every body by one factor, about the origin or about the centre of the bodies. {idx:scale}

## Long operations

If a feature takes more than a few seconds, a banner above the model says what is being worked on ("Still working on Extrude Cut1 (12 s)…") with a **Stop** button (also next to the progress bar). Stop restarts the geometry kernel: a feature you are still editing is cancelled and a finished feature is suppressed, so you can unsuppress it to try again. {idx:Stop}

# Bodies and Multi-Body Parts

## Solid bodies

A part can contain several solid bodies. A boss that doesn't touch the existing material makes a new body; untick **Merge result** to keep a touching boss separate. A cut that slices a body in two leaves two bodies. {idx:bodies}{idx:multi-body}

The **Solid Bodies (n)** folder at the top of the tree lists the bodies:

- Click a body to select and highlight it.
- Double-click (or right-click ▸ **Rename**) to name it. Unnamed bodies are named after the last feature that changed them.
- Bodies are identified by the feature that created them, so names and materials stay attached when you change dimensions.
- **Folders**: right-click ▸ **Add to New Folder** or **Move to folder** to organise bodies.
- **Identical bodies** are listed once with their count (×N). Open the item to see each body. Right-click for Isolate, Hide or Show all of them. Identical means the same volume, surface area, principal moments of inertia, handedness and material (and for sheet metal, the same thickness and flat pattern). {idx:identical bodies}

## Body Properties

Right-click a body (tree or view) ▸ **Body Properties…**. It holds the body's name, **material**, description and any number of **custom properties** (name/value pairs such as part number or finish). It also shows the body's mass, volume, area and centre of mass. For sheet metal bodies it adds the sheet data (Sheet Metal chapter). {idx:Body Properties}{idx:custom properties}

## Materials

The **Material** item in the tree sets the part material (**Tools ▸ Edit Material…**). A body set to **Use part material** follows it. A body given its own material keeps it when the part material changes and is drawn in that material's colour. Mass Properties adds up every body with its own density. The material list is in Appendix B. {idx:materials}

## Appearance

Right-click a face ▸ **Appearance…** or a body ▸ **Body Appearance…** to give it a colour, or **Default colour** to set it back. Face colours stay with their face when the model changes. A body's own appearance wins over its material colour and over colours imported from a STEP file. {idx:appearance}

## Render and decals

**Evaluate ▸ Render** makes a photorealistic picture of the view as it is now {idx:render}{idx:photorealistic}: choose the size (as the view, or up to 3840 × 2160), the **Quality** (Draft: one pass; Good: 16 passes, Best: 64, each with the view and the light moved a little and the passes averaged, for smooth edges and soft shadows), the lighting (**Studio**, **Outdoor sky**, or studio on white), a soft **shadow on the floor** and the exposure, and a **look** for each body: polished, brushed or cast metal, gloss paint, powder coat, glossy or matte plastic, rubber or glass, or **From the material** (aluminium and stainless brushed, steel cast, brass and copper polished, ABS glossy, PLA and nylon matte). Bodies keep their colours, and their looks are kept with them. **Save PNG…** writes the picture.

**Evaluate ▸ Decal** {idx:decal} puts a picture (a logo, a label) on a flat face: open the picture, give its width and angle, then click the face where its middle goes. Decals show in the view and in renders, are saved with the part, and are not geometry. **Tools ▸ Decals…** lists them, to delete them.

## Exploded views of a part

A part with two or more bodies can have exploded views: **Insert ▸ Exploded View…**, or right-click the Solid Bodies folder. Only the display moves; the model stays as it is. The steps are made as for an assembly (see Exploded views in the Assemblies chapter). {idx:exploded view, part}

## Combine and Subtract Bodies

**Combine** joins bodies with **Add**, **Subtract** or **Common**; the first body clicked is the main body. **Subtract Bodies** picks a cutting body and target body; **Consume cutting body** (on by default) removes the cutting body afterwards. {idx:combine}{idx:Subtract Bodies}

## Split

Cuts bodies into separate bodies with a plane, a flat face or a surface body. With a plane or face you can keep all the pieces or just the piece on one side. {idx:split}

## Move/Copy Bodies

Moves or copies solid and surface bodies. {idx:Move/Copy Bodies}{idx:mates}

- **By coordinates**: ΔX/ΔY/ΔZ plus a rotation about X/Y/Z or a reference axis, through the axis or the bodies' centre. Copies repeat the step.
- **With mates**: Coincident, Distance, Parallel, Perpendicular, Angle and Concentric between an entity of the moving bodies (face, edge, vertex) and fixed geometry (another body, a plane, axis or point). **Flip alignment** turns a mate around.

## Delete Body

Removes a body from the model from that point in the history. Deleting the Delete Body feature brings the body back. {idx:Delete Body}

# Surfaces

The **Surfaces** tab builds surface bodies (zero-thickness faces), listed under **Surface Bodies** in the tree. Cuts and Combine only act on solid bodies; Knit, Thicken or Convert to Solid turn surfaces into solids. {idx:surfaces}

## Making surfaces

| Feature | What it does |
|---|---|
| **Extruded Surface** | Extrudes selected regions, open/closed contours or individual entities; one side, symmetric total depth or independent depths on both sides; reverse supported |
| **Revolved Surface** | Revolves selected regions or open/closed contours with separate axis selection, optional axis projection and the same Full/Angle, one-side/two-side/symmetric controls as solid Revolve |
| **Planar Surface** | Creates flat surfaces from selected sketch regions, closed entity contours or coplanar model boundary edges; sketch regions preserve their holes |
| **Lofted Surface** | A surface through two or more profiles (sketches or 3D sketches), open or closed, optionally ruled (straight between profiles). Open profiles drawn in opposite directions are lined up automatically. **Guide Curves** (rails, optional): sketches or curves the surface follows between the profiles, e.g. along its edges; each runs from the first profile to the last, through every profile. One guide pulls the surface along it; two or more shape it across, each where it touches the profiles. |
| **Swept Surface** | An open or closed sketch profile, or a circle, swept along a sketch, 3D sketch, helix or chain of model edges. **Orientation** (including Square to faces), **Twist angle**, **End scale** and an optional **Guide** work as for Sweep (see Sweep and Sweep Cut); with a guide the profile can be open or closed. Closed profiles give a surface without end caps. |
| **Filled Surface** | A smooth patch over a hole bounded by one closed loop of edges of a surface or a solid, touching (G0), tangent (G1) or matching curvature (G2) with the faces round it; the condition can be set for each edge. It can be knit into the surface and close a solid. A flat loop gives a flat patch. |
| **Boundary Surface** | A surface through curves in two directions. The first and last curve of each direction bound it and must meet at their ends; the curves between shape it. **Meeting other faces** makes it **tangent (G1)** or **curvature continuous (G2)** to faces you pick (**Select support faces**): each bounding curve that runs along an edge of one of them meets that face so; the others just touch. It is checked on the CAD faces as for Filled Surface (contact 0.0001 mm, 0.5°, 0.001 1/mm) and the note gives what was measured. The curves must agree with the faces where they meet (a side curve leaving a G1 edge must leave along the face; for G2 its first three control points in line with it). |
| **Ruled Surface** | Straight-sided surfaces standing on edges, either normal to the surface or along a direction tapered by an angle, on one or both sides (for example mould parting surfaces) |
| **Offset Surface** | Offsets faces of any body |
| **Copy Surface** | Copies faces of any body as surface bodies, leaving the body unchanged. **Join copies that touch into one surface body** is on by default. |

{idx:Lofted Surface}{idx:Swept Surface}{idx:Filled Surface}{idx:Boundary Surface}{idx:Ruled Surface}{idx:Copy Surface}

### Guide control for Swept Surface

Swept Surface uses the same separate canvas selectors and per-role Chain selection as solid Sweep. Choose one open or closed profile contour without holes; a region with inner loops must be reduced to the desired contour. Whole-sketch sources remain available explicitly for older workflows.

Without a guide, **Orientation** and **Twist angle** work as in solid Sweep: perpendicular sections with an optional signed total twist, or sections parallel to the initial profile. Open and closed profiles remain uncapped. The same open, tangent-continuous path restriction and numerical checks apply to nonzero twist.

**Guide (optional)** uses the same **Orientation** and **Section size** controls as the solid Sweep. Orientation keeps the profile dimensions; Section size uniformly scales the profile to follow the guide. Use one connected profile chain, open or closed, with an open path and guide. The guide must span the endpoint normal planes of the path; Section size also requires it to start on the profile curve and intersect every path normal plane once. Guide contact on the CAD surface is checked numerically to **0.0001 mm**, using the same bounded scale-law refinement as solid Sweep. These are sampled numerical checks, not a certified global bound.

Open profiles form a sheet. Closed profiles and the Circular option form an uncapped surface shell; no end caps or solid are added. Removing the guide restores the ordinary swept surface.

### Start and end conditions for Lofted Surface

Lofted Surface uses the same **Start Condition**, **End Condition**, **Influence** and **Reverse tangent direction** controls described under Loft. Adjacent support faces can belong to solids or surfaces. Open profiles form a sheet; closed profiles form an uncapped shell. Guide curves can be combined with endpoint conditions using **Adaptive approximation**, with the same endpoint-tangent compatibility and sampled CAD contact checks as solid Loft.

### Guide construction for Lofted Surface

Select **Guide Curves → Guide construction → CAD constraints (two profiles)** to use the original guide edges as patch boundaries. This supports open profiles forming a sheet, or closed profiles forming an uncapped surface shell. Guides can lie in different planes, making a nonplanar surface. A closed profile does not add end caps or make a solid.

The kernel checks the patch contact error to **0.0001 mm**, validates the resulting CAD shape and checks points on the guide curves independently. **Across guide seams** offers **C0** (contact), **G1** (tangency) and **G2** (curvature continuity) along shared guide edges. G1 checks native CAD normals at nine interior positions, allowing at most **0.5°** mismatch. G2 constructs a C2 B-spline surface for internal guide networks, trims the resulting patches and checks contact, normals and all three components of the second fundamental form at 33 independent positions on each seam. Its curvature mismatch limit is **0.001 1/mm**. Measured angular and G2 curvature mismatches appear in the feature note. These are numerical tolerance checks, not a symbolic proof that every guide point is exact. The method requires two compatible profiles without holes or Thin Feature. Original profile corners are preserved. A transverse guide through a sharp corner cannot provide G2 continuity: choose C0 or move the contact onto a smooth profile segment. Circular profile seams are positioned automatically; straight guides already on a cylinder or cone preserve its geometry. Incompatible constraints report an error without lowering continuity or switching methods. Choose **Adaptive approximation** explicitly for other supported loft configurations.

### Surface Extrude and Revolve selection

These commands use the same canvas profile/contour selector as Planar Surface and solid features. Turn off **Chain selection** for individual sketch entities and confirm the contour with **Add selected contour**. Unlike a solid profile, an open chain is valid. Selecting a region uses its boundary curves, including holes, without automatically using unrelated curves from its sketch. Closed contours remain surface shells; the command does not turn them into solids. Earlier whole-sketch features still rebuild and can be edited through the explicit whole-source fallback.

Surface Revolve has separate profile and axis slots; the axis can come from another sketch. Surface Extrude's **Symmetric** depth is the total depth, while **Two sides** uses Depth and Second depth independently. Surface Revolve shares Full/Angle and one-side/two-side/symmetric behavior with solid Revolve, and goes **Up To Vertex** or **Up To Surface** too (a plane beside the axis trims it, as for solid Revolve). These surface commands create new surface bodies.

**Model edges and faces** {idx:model edges (surface extrude)}: besides sketch contours, both commands take edges of the model. **Model Edges → Select model edges**, then click edges on solids or surfaces (click again to remove one; **Chain selection** follows a surface body's open boundary). The edges join end to end into chains, open or closed; edges that branch are refused. Clicking a flat face of the model while choosing contours uses that face's outer and inner edges. Edges in one plane extrude square to it, out of the face they border when they lie on one; edges that do not lie in one plane, or a single straight edge, need **Along** (below). Surface Revolve revolves the chains about its axis, which must then be a reference axis, a model edge or face, or a line of a sketch.

**Surface Extrude start, end, direction and draft** {idx:surface extrude}: **Start from** is the contour plane, an offset from it, or a plane / planar face, as for solid Extrude. **Direction** adds **Up To Vertex**, **Up To Surface** and **Offset From Surface** to One side, Two sides and Symmetric; an angled start or end surface trims the extrusion along it. **Along** chooses an axis to extrude along instead of square to the contours (None); Depth is then measured along it, and an axis that lies in the contours' plane is refused. **Draft angle** tilts the walls of closed contours about where the extrusion starts, each contour narrowing away from it (or widening with **Draft outward**), as for solid Extrude; an open contour of sketch lines and arcs leans to its left as drawn (**Draft outward**: to its right), each line and arc offset in the contour's plane as the extrusion rises, so its faces stay flat and conical.

### Planar Surface selection

Use **Sketch Profiles → Select profiles in canvas** to click inside a closed region or select its contour. Each selection adds only that region, including its inner holes, instead of every profile in its sketch. Click a selected profile again to remove it. **Chain selection** follows connected sketch entities; turn it off to pick individual curves, then use **Add selected contour** once they close. Selecting just an outer contour fills that outline; click the actual region to include its holes.

Use **Model Boundary Edges → Select model edges** for existing solid or surface edges. Choose one connected, closed, coplanar loop, with optional chain selection. The kernel rejects open, duplicate, missing or nonplanar boundary edges. Each selected sketch region creates a planar face; multiple independent regions are supported. Profiles remain linked to their source entities when dimensions change, and deleted selected entities require reselection.

Existing whole-sketch features remain compatible. **Other sources (whole sketch / curve)** keeps whole-sketch selection available explicitly. A sketch with multiple regions no longer gets selected in full automatically when starting Planar Surface: choose the desired profiles in the canvas. Planar Surface creates flat sheets; use Filled Surface for a nonplanar patch or continuity to adjacent faces.

### Filled Surface / Patch continuity

Select one connected, closed boundary loop. **Chain selection** is enabled for new patches: click an edge to add its connected boundary chain on that body; click a fully selected chain again to remove it. Turn the checkbox off to add or remove individual edges. Partial chains are completed without duplicate edges or changing existing per-edge continuity. Selection stops at branches; for solid edges, an explicitly selected support face can identify its boundary loop. The checkbox is saved with the feature; older files keep individual selection until enabled.

**Boundary continuity** sets **Contact (G0)**, **Tangent (G1)** or **Curvature (G2)** for the loop. Each edge can override that setting, so a patch can combine G0, G1 and G2 boundaries. Open, disconnected, duplicate or multiple loops report an error.

**Tangent reach** {idx:patch, tangent reach}: a tangent (G1) edge's row has a reach in mm (0 by default). With a reach, the patch also passes through points that far in from the edge along the support's tangent plane, so it keeps to that plane further before it turns towards the middle: a fuller, flatter rim. It applies to G1 edges only.

**Pass Through** {idx:patch, pass through}: **Add a curve it passes through** adds sketches, 3D sketches and curves lying inside the opening; **Add points it passes through** adds reference points, or a sketch's own points (those not on its curves). The patch passes through all of them as well as meeting its boundary; each is checked on the result to **0.0001 mm** (the constraints are sampled more finely until it passes, or the patch reports how far off it is).

G1/G2 edges require an adjacent support face. An open surface edge infers its unique adjacent face. Use **Select support faces** when a solid edge has two adjacent faces; exactly one selected adjacent face must cover each constrained edge. **Select boundary edges** returns to picking edges. G0 does not require support faces. Older files with **Tangent** enabled keep G1 behavior, with strict verification instead of a contact-only fallback.

The resulting CAD face is checked for validity and sampled at 33 positions on each boundary: contact within **0.0001 mm**, G1/G2 normal mismatch within **0.5°**, and G2 mismatch of all three curvature components within **0.001 1/mm**. Boundary trimming curves are checked again after knitting. Incompatible supports or failed constraints remain errors; the requested continuity is not downgraded. These checks are sampled numerical bounds, not a global mathematical proof. A latitude opening in a spherical face preserves its exact spherical continuation; other constrained patches use native plate construction with bounded refinement and final CAD checks.

**Knit into the surface** joins the patch when all selected edges belong to one surface body. **Make a solid when that closes it** closes a watertight result; if other openings remain, the result stays a surface and its note says so. Example: `tests/data/surface-patch-g2.rcad`.

## Changing surfaces

| Feature | What it does |
|---|---|
| **Trim Surface** | Cuts surfaces with a plane, a surface body or a sketch's curves (square to the sketch). Click the pieces to keep, or to remove. **Mutual** trims the tool surface too. |
| **Extend Surface** | Carries open edges straight on by a distance, following the surface's slope at the edge, and knits the extension on |
| **Untrim Surface** | Fills a surface's holes, or gives it back its natural extent (holes and outline). Pick faces to untrim only those. |
| **Knit Surface** | Sews surfaces together within a gap tolerance. When they enclose a volume, **Try to form a solid** turns them into a solid. |
| **Thicken** | Gives a surface a wall thickness (one side or both) and makes it a solid |
| **Delete Face** | Takes faces out of a solid or surface. Either leave the hole (the body becomes a surface body), patch each hole smoothly, optionally tangent, so the solid stays solid, or **Heal**: the faces round the hole grow or shrink until they meet and close it exactly, with no patch (a boss or a rib deleted as if it was never there). Good for removing fillets and bad faces from imported parts. |
| **Replace Face** | Moves flat faces of a solid onto a surface body, so the body grows or shrinks to meet it (for example a curved top). The surface must reach past the faces all round. |
| **Freeform** | Reshapes one face of a solid or surface by handles you push in or out (see below) |
| **Flatten Surface** | Unrolls faces of a surface or solid flat beside the model as a surface body (see below) |
| **Split (with a surface)** | Splits solid bodies with a surface body |
| **Move/Copy Surfaces** | As Move/Copy Bodies, for surfaces |
| **Delete Surface** | Removes a surface body |

{idx:Trim Surface}{idx:Extend Surface}{idx:Untrim Surface}{idx:knit}{idx:thicken}{idx:Delete Face}{idx:Replace Face}

### Freeform {idx:Freeform}{idx:freeform face}{idx:push and pull a face}

**Surfaces ▸ Freeform** reshapes one face by a grid of handles. Click the face: a flat face of any outline, holes and all (the top of a block or a disc, a plate with holes), or a freeform face (a lofted or fitted face, or one Freeform has already reshaped). On a flat face with four straight edges or a freeform face that covers its whole surface, **Keep at the edges** sets what is held there. On any other face (another outline, holes, a trimmed freeform face) only the inside moves: the face stays as it was in a band along every edge and hole, so it always meets them in tangent plane and curvature (G2), and handles that fall outside its outline are left out (the note says how many are on the face). Rounds and other curved faces can't be reshaped yet. Set how many handles there are **Across** and **Along** the face (1 to 6 each): they sit evenly across it, and each **Handle** is how far the face is pushed out there (below 0, in), along its normal. The face passes through every handle exactly. **Drag a handle** on the model, in or out of the face, to move it; the face rebuilds when you let go.

**Keep at the edges** says what the face keeps where it meets the faces round it: **Contact (G0)** (only the edges stay where they are), **Tangent (G1)** (the tangent plane along them too, so a face that ran smoothly into its neighbours still does; the default) or **Curvature (G2)** (the curvature as well). The more is kept, the closer to the middle the shape changes and the less it bulges. The face is made an exact B-spline surface and its control points are moved (the outer one, two or three rows of them held); the note gives how closely the handles are met and, measured on the CAD faces, how closely the tangent plane and curvature along the edges are kept. A face that would run through another face cannot be closed into the solid: use smaller heights.

## Curves and split lines

| Feature | What it does |
|---|---|
| **Split Line** | Splits faces along a sketch's projection, or where a plane or surface crosses them. The body stays one body with its faces split, for example for a parting line, a draft or a colour. |
| **Projected Curve** | Projects a sketch along its normal onto faces, as a 3D curve |
| **Composite Curve** | Joins model edges end to end into one curve |

Projected and composite curves can be used as sweep paths, lofted surface profiles, curve-driven pattern paths and boundary surface curves. {idx:Split Line}{idx:Projected Curve}{idx:Composite Curve}

## Flatten Surface

Click the faces to unroll. Faces that unroll (cylinders, cones, bent sheets) come out exact. A doubly curved face (for example a dome) can't lie flat without stretching: it is spread out keeping its edge lengths as well as possible, and the note gives the size, the area change and how much the edge lengths changed. **Relaxing passes** sets how hard it tries. A closed tube needs a seam (Split Line) to open out. {idx:Flatten Surface}

## Meshes and closing surfaces

- **Convert to Solid** (also right-click a surface body): surface bodies that together enclose a volume, or a mesh, are joined (edges closer than the gap tolerance meet) and made into one solid. When they leave gaps it says how many open edges and holes there are. {idx:Convert to Solid}
- **Repair Mesh**: closes the holes of a surface body or a mesh with missing pieces (flat holes with a flat face, curved holes with a filling surface, holes in a mesh with triangles), turns triangles that face the wrong way round, and makes a solid. Option: the largest hole to close. {idx:Repair Mesh}

Surface quality can be checked with Zebra Stripes, Curvature and Draft Analysis (Evaluate and Tools chapter).

# Reference Geometry

## Reference Plane

Reference Plane, Reference Axis and Reference Point share a **References and Relations** panel with three numbered slots. Pick sketch geometry, model geometry or an earlier reference feature in the canvas or tree. The **Choose reference geometry** list also offers individual sketch lines, arcs, circles, supported splines and points (including the sketch origin), grouped by source sketch. Entries show the entity name and stable ID; suppressed, failed and later sketches are omitted. Hidden source sketches are temporarily displayed without changing their saved visibility. Click a slot to replace its reference; a fourth pick never discards an existing reference. Click a selected reference again, or its remove button, to remove it. References remain linked to their sources. {idx:reference plane}

Each slot offers compatible **Relation** choices. **Automatic** chooses the usual relation for the selected combination; selecting an explicit relation keeps that choice when other references change. Distances and angles accept expressions. References must precede the feature in the tree.

The displayed rectangle of a reference plane is centered near its defining line, point or path location, projected onto the plane. This display position does not change the plane's sketch coordinate system. For rotation about a line, use **Coincident / through** on the line and **At angle** on a reference plane.

**Fully Defined** means the supported constraints have a finite solution with no remaining continuous freedom. **Under Defined** identifies missing constraints; **Conflicting** identifies incompatible geometry, relations or values. An axis direction alone does not fix its position, and two points alone do not fix a plane. Incomplete and conflicting definitions cannot be accepted. When two distinct geometric solutions exist, **Solution 1 / Solution 2** selects the branch; opposite normals of the same plane are handled by **Reverse its normal** instead.

| Reference geometry | Available plane relations and constructions |
|---|---|
| Planar face or plane | Coincident, Offset, Parallel, Perpendicular, At angle |
| Point or vertex | Coincident / through |
| Straight edge, sketch line or reference axis | Coincident / through, Parallel, Perpendicular, At angle; Normal at position |
| Sketch circle/arc or circular model edge | Its containing plane supplies Coincident, Parallel, Perpendicular and At angle relations |
| Two planes/faces with Midplane relations | Midplane of parallel planes, or either angular bisector |
| Cylindrical face | Tangent, with an angle round the cylinder; optionally parallel to one selected plane, with either side available |

Examples: three non-collinear points define a plane; a line with **Coincident** plus an external point defines the plane through both; a line with **Perpendicular** plus a point defines a normal plane through that point. A line with **Coincident** and a plane with **At angle** can define two angular solutions. Skew lines, inconsistent angles and invalid tangent combinations report conflicts. **Normal at position** uses the selected segment's start, midpoint, end or a distance within a straight segment. A reference axis supplies a direction and its stored anchor.

The solver uses affine equations and the unit-normal constraint, rather than a tessellated approximation. Numerical rank and consistency checks distinguish free, unique and incompatible definitions. Tangency currently supports a cylinder alone or a cylinder with one parallel plane; midplane supports two plane references. Arbitrary curved-surface relations and additional constraints on these special constructions are not supported yet.

**Placement** transforms the constructed plane after its reference relations have been solved: move along its normal, turn its sketch axes in the plane, or reverse its normal. An Offset relation already supplies its signed distance and has **Flip offset direction**.

Existing plane and axis constructions keep their original geometry and anchor when opened for editing. The panel identifies the preserved construction; changing a reference or relation upgrades it to the constraint definition. Cancel restores the original saved definition.

### Plane Along Path and point along a curve

In Reference Plane or Reference Point, select a sketch line, arc, circle or spline, a model edge, or an earlier helix/3D/composite/projected curve feature. Choose the reference relation **Along path (arc length)**. The source picker and tree also offer curve features; a feature containing several disconnected routes must be reduced to one connected path first.

**Position** offers Distance along curve, Fraction (0–1), Start, Half arc length and End. Distances and fractions accept expressions. **Reverse path direction** measures from the opposite end and reverses the tangent used by the plane. A fraction follows changes in the total curve length; a distance retains its physical length when the source changes. Closed paths retain the curve's existing seam; distances outside the path are rejected rather than wrapped.

The plane passes through the computed position, has its origin there and is normal to the local tangent. The point uses that same position. A point can lie at a corner or cusp; a plane cannot be made there without a unique tangent. The preview identifies a conflict at detected corners, singularities or nonsmooth closed seams instead of choosing one tangent arbitrarily.

Locations use adaptive integration of curve speed and bounded inversion of the resulting arc length, independently of display tessellation. Sketch splines retain their original Bézier pieces, degree and rational weights. Model edges and curve features use derivatives of the actual CAD curve and an independent CAD length check. Position inversion targets **0.0000001 mm** or **1e-10 of the path length**, whichever is larger; refinement exhaustion reports an error. These are numerical convergence controls, not a certified global error bound. Existing Midpoint and straight-segment Distance relations keep their previous meanings; choose Along path explicitly for arc-length placement.


## Reference Axis

Uses the same three slots, per-reference relations and definition states. Two points define a through-axis; two intersecting planes define an axis in both. A straight edge or sketch line supplies its line, a circular edge supplies its centre axis, and a cylindrical or conical face supplies its centre axis. Plane **Perpendicular** plus a point defines a normal axis through that point. Parallel and perpendicular relations can constrain the direction while other references constrain the position. {idx:reference axis}

Axes remain linked, are drawn dashed and can drive a revolve or a pattern. Right-click an edge and choose **Reference Axis** to preselect it. Parallel distinct planes, coincident points and zero-length directions cannot define the requested axis.

## Reference Point

Choose **Coordinates** (expressions allowed) or **Reference geometry**. The latter uses the shared slots and states. A point/vertex can be copied; a selected sketch line or model edge can supply its start, end or midpoint, and a circular curve can supply its centre. **Distance from start** currently supports straight segments and rejects distances outside the segment. {idx:reference point}

**Coincident** relations intersect straight lines and planes: two crossing lines, a line crossing a plane, or three independent planes can define one point. A point on one plane retains two degrees of freedom; one on a line retains one. Skew lines, incompatible planes and missing references report conflicts. Circular and other curved-edge midpoint positions use the kernel's normalized curve parameter, preserving the existing Edge midpoint behavior; they are not a general arc-length locator. Use **Along path (arc length)** above to locate a point by physical curve distance or fraction. Two references where one is curved also give a point where they meet: a curved model edge (circle, arc, spline) and a plane, a flat face, a curved face or another edge, or a curved face and an axis. When they meet more than once, the panel says how many crossings there are and **Next solution** steps through them, in a fixed order. A curved face and a plane meet along a curve, so that pair is refused: pick an edge of the face instead.

Right-click a vertex and choose **Reference Point** to preselect it. Coordinate mode retains its stored reference choices but does not depend on or evaluate them.

# The Feature Tree and History

## Editing features

- Double-click a feature, or right-click ▸ **Edit Feature**, to open its Property panel. {idx:edit feature}
- Select a feature and press [[Del]] (or **Edit ▸ Delete**) to delete it.
- **Edit ▸ Undo / Redo** ([[Ctrl+Z]] / [[Ctrl+Y]]) works on the whole part history.
- **Rebuild** ([[Ctrl+B]], or the quick button) rebuilds the part.
- A feature that fails shows an error in the tree so you can fix or re-pick its references (see Fix References).

## References that follow edits

Features that use picked edges and faces (fillets, chamfers, shells, drafts, axes…) find them again after the model changes. An edge remembers the faces on its two sides and whether it is an outside or inside corner. When a dimension moves it so far that other edges now lie nearer its old place, the right edge is still found, and an edge of another kind is not taken for it. A face that moved is found as the face facing the same way that is clearly nearest. A reference found again this way is updated, so it keeps following the model. {idx:references}

## Fix References

**Tools ▸ Fix References…** lists every feature that failed to rebuild, what went wrong and which of its edges or faces are no longer in the model. Open it also by clicking the red error count in the status bar, or by right-clicking a failed feature. For each feature: {idx:Fix References}

| Button | What it does |
|---|---|
| **Edit** | Opens the feature (or sketch) to pick its references again |
| **Remove missing** | Keeps the references that are still found and drops the others |
| **Suppress** | Leaves the feature out for now |

Fix them from the top: a feature can fail only because one above it did. The list follows every rebuild while it is open.

## Rollback bar

The blue line at the bottom of the tree. Drag it up, or right-click a feature ▸ **Roll Back** / **Roll to End**. Features below the bar are suppressed, and new features are inserted above it. {idx:rollback bar}

## Reordering features

Drag a feature up or down the tree. Its absorbed sketch moves with it. A move that would break a reference is refused with the reason. {idx:reorder features}

## Reference arrows

Select a feature in the tree. Blue arrows come from what it uses; purple arrows go to what uses it. {idx:reference arrows}

## Tree symbols

Sheet metal features and bodies have their own icons. Under-defined sketches show **(-)**. Sketches absorbed by features are hidden by default.

# Sheet Metal

The **Sheet Metal** tab holds the sheet metal features. Sheet metal bodies are listed in the **Sheet Metal Bodies** folder below Solid Bodies, with sheet metal icons. {idx:sheet metal}

| Group | Features |
|---|---|
| Making a sheet | Base Flange, Sheet Metal Extrude, Lofted Bend, Transition / Reducer, Convert to Sheet Metal |
| Flanges and bends | Edge Flange, Miter Flange, Hem, Sketched Bend, Jog |
| Forms and details | Cross Break, Tab and Slot, Forming Tools, Gusset |
| Corners | Corner Relief, Closed Corner |
| Flat | Unbend, Bend, Flatten |
| Checking and output | Sheet Metal Check, Export DXF, Export All DXF, Nest Flat Patterns, DXF Settings |

## Base Flange

A closed sketch (holes allowed) becomes a sheet of the given **thickness**. The **bend radius** and **K-factor** set here become the part's defaults. {idx:Base Flange}{idx:K-factor}

**Bend calculation** {idx:bend allowance}{idx:bend deduction} (Base Flange, Sheet Metal Extrude, Lofted Bend, Transition): **K-factor**, or, from your bend table for this thickness and radius, the **Bend allowance** (the length a 90° bend takes flat) or the **Bend deduction** (how much shorter the flat is than the two outside lengths to the sharp, for a 90° bend). RazorCAD works out the K-factor it gives (refused when outside 0 to 1), so every flat length agrees with the table at 90° and other angles follow in proportion. **Bend table (by angle)** takes the allowance for several angles ("30: 1.5; 45: 2.0; 90: 4.2", for this thickness and the default radius): each bend's allowance is read from it, straight between its rows and in proportion past its ends; bends of another radius use the K-factor its 90° allowance gives.

## Gauge tables

Base Flange, Sheet Metal Extrude and Transition / Reducer have a **Gauge** list: mild steel, steel gauges, stainless 304, and aluminium 5052 and 6061-T6. Picking a gauge sets the thickness, inside bend radius and K-factor. **Save…** keeps your own values as a gauge. {idx:gauge tables}

## Sheet Metal Extrude

Extrudes an open sketch of lines and arcs into a sheet metal part. Arcs in the sketch are bends of their own radius; sharp corners get a bend of the inside radius set in the panel. Material goes on one side, the other side or both sides of the sketch; depth one way, reversed or mid-plane. A circle on its own is rolled into a cylinder, leaving a seam gap. Flanges, hems, Flatten and DXF export work on it. {idx:Sheet Metal Extrude}

## Lofted Bend

A sheet metal part between two open profile sketches (each one chain of lines and arcs), for example a round-to-square transition, hopper or duct piece. Points are matched along both profiles by length, keeping every corner of either profile. {idx:Lofted Bend}

- **Method**: **Bent** makes flat facets folded along straight lines, each fold a bend line in the flat pattern and DXF; set the number of divisions. **Formed** makes a smooth sheet (rolled or pressed), with the set number of forming lines along the profiles.
- The flat pattern is developed at the neutral layer (K-factor) and works with Flatten, DXF export and flat pattern drawings. **Material on the other side** flips the thickness.
- A cut through a lofted bend is carried into its flat pattern, and the cut edges are square to the sheet, as a laser-cut blank formed to shape would be. This makes trimmed conical parts possible: loft the cone between two arcs, then cut it to the outline with a revolved cut.
- Edge flanges, corner reliefs and closed corners can't be added to a lofted bend; its shape comes from the profiles.

## Transition / Reducer

Cones, concentric and eccentric reducers, square-, rectangle-, triangle-, pentagon- and hexagon-to-round transitions (either way up) and polygon frustums. {idx:Transition / Reducer}{idx:reducer}

- Sizes, offset and rotation are set in the panel; sizes can be inside, outside or mean. A sketch line from bottom centre to top centre places the part and sets its height; change the line and the part follows. Started with no sketch, it asks for a plane and opens the Line tool.
- The part is made from a number of equal pieces, each a sheet metal body with its own flat pattern: a cone from one piece or more, a flat-sided transition from two or more, with seams at the middle of the flat sides or at the corners.
- **Formed** (rolled, with a set number of forming lines per corner or round the whole part) or **bent** (bump formed with a set number of bends).

## Edge Flange

Click straight edges on the top or bottom face. {idx:Edge Flange}

| Setting | Options |
|---|---|
| Length | Measured to the outer virtual sharp, inner virtual sharp or tangent |
| Flange width {idx:Edge Flange, partial} | **Along the edge**: the whole edge, **Offsets from its ends** (from the start, from the end; **Swap the ends**), or **A width in its middle**; the rest of the edge stays as it is, with reliefs where the bend ends |
| Angle | Flange angle |
| Position | Material inside, material outside, bend outside, plus an offset; flip |
| Bend radius | Its own radius, or the default |
| Auto relief | Rectangular, obround or tear relief where a bend ends next to material |
| Corners | Flanges picked together that meet at a corner: **Corner to corner** (the default: each runs on up to the other's inside face and ends square, their inside edges the gap apart; the outside corner is left open and the bends end in a V cutout), **Mitred** (they meet on the diagonal), **Overlap** (one runs on to cover the other's end) or **Open**. Closed corners keep a gap (default 0.5 mm). For Overlap, **Swap** reverses which covers, and the Bend region is a V cutout or Closed. |

## Miter Flange

A flange with a profile of up to four segments along a chain of edges. Each segment has a length (to the outside of the bends) and an angle; a negative angle folds back the other way, so 90 / 90 makes a C and 90 / −90 a Z. The corners are mitred (closed, with a gap) at every level. **First bend** sets where the material sits on the edge, as for an edge flange. {idx:Miter Flange}

## Hem

Folds a straight edge back on itself. Hems meeting at a corner are mitred. {idx:Hem}

| Setting | Options |
|---|---|
| Type | **Closed** (pressed flat), **Open** (with a gap), **Teardrop** (its own angle, default 225°) or **Rolled** (a curl) |
| Length | From the outside of the fold |
| Gap, inside radius, angle | As the type needs |
| Position | **Inside** (the fold at the edge) or **Outside** (added beyond the edge); flip direction |

## Sketched Bend

Draw lines on the top or bottom face of a flat part of the sheet; the sheet is bent along each one. Set the angle, the radius (or the part's), whether the bend is centred on the line or starts or ends at it, the fold direction and which side stays put. The flat pattern stays the plate it was. {idx:Sketched Bend}

## Jog

One sketch line on a face makes two opposite bends that step the sheet over by a height. The height is measured face to face, outside to outside or inside to inside; the jog says when the height is too small for the bends. {idx:Jog}

## Cross Break

Click flat faces to mark an X of shallow stiffening folds. It shows in Flatten, in the DXF (on the Forming marks layer, with a note) and in flat pattern drawings. {idx:Cross Break}

## Tab and Slot

Click the edge of one sheet metal part where it sits on another, then the face of the other part. Tabs are added along the edge and matching slots, with clearance all round, are cut through the other part, so the parts locate each other for welding. {idx:Tab and Slot}

- Settings: number of tabs, tab length, tab height (empty: through the other part), margin at each end (empty: evenly spread) and clearance.
- Both flat patterns and DXFs get the tabs and slots.

## Forming Tools

**Forming Tools** presses a form into the sheet. Place forms at clicked points, or exactly at the points and circle centres of a sketch on the face (for a louver, its lines). They are pressed toward the face they are placed on, or the other way. {idx:Forming Tools}{idx:dimple}{idx:louver}{idx:extruded hole}

| Form | Settings |
|---|---|
| **Dimple** | Diameter, depth |
| **Extruded (flanged) hole** | Hole diameter inside the collar, collar height, bend radius |
| **Louver** | Width back from the slit, opening height, hood side; drawn as a line on the face (the slit) |
| **Bead** {idx:bead, sheet metal} | A round-topped stiffening rib along each sketch line, its width and height (at most half its width), its ends rounded |
| **Lance** {idx:lance} | A bridge: slits along the sketch line and its width from it, the strip between pressed out by the height and ramped back at 45° at its ends; both slits are cut lines in the flat pattern |
| **Emboss** {idx:emboss, sheet metal} | Each closed outline of the sketch raised (or pressed, with Flip) by the height, with straight walls the sheet's thickness; its outline is marked in the flat pattern |

The flat pattern gets a centre mark and a note for each form, an extruded hole's pre-hole (the collar laid flat) and a louver's slit as a cut. Forms stay with the part through later sheet metal features and are left off, rather than breaking the part, if one can't be made.

## Gusset

Click a bend (its round face) to press a stiffening dart across it at that point. Set the size of each leg from the inside corner and the width across the bend; tick **Pressed down** to press it the other way. The flat pattern marks it. (For gusset plates between structural members, see the Fast Structure chapter.) {idx:Gusset, sheet metal}

## Corner Relief

Adds a rectangular, circular or tear relief at every corner where two bends meet. {idx:Corner Relief}

## Closed Corner

Closes the corners between 90° flanges: one flange covers the other's end, with a gap. {idx:Closed Corner}

- **Corner type**: Overlap, Underlap, Butt (square ends: each flange runs on up to the other's inside face, the gap between their inside edges, the bends in a V cutout) or Mitre (the gap across the mitre, bends included).
- **Which corners**: click a face of a flange next to a corner and the matching flange is found automatically; the clicked flange is the one that overlaps or tucks under. With no corners picked, every corner of the body is closed.
- **Swap** reverses which flange covers.
- **Bend region**: **V cutout** (default) runs each bend into the corner as it would form from the flat, leaving a small teardrop-shaped opening with a relief at the corner point. **Closed** keeps the bends meeting on the diagonal.
- The flat pattern matches the folded part at closed corners, including each bend's run-on, the relief and the corner round.

## Unbend and Bend

**Unbend** keeps the picked face in place and flattens the rest. Features after it (such as cuts across bends) are made in the flat. **Bend** folds it back to where it was. Both appear in the tree. {idx:Unbend}{idx:Bend}

## Cuts and other features on sheet metal

Cuts on sheet metal (extruded cut and so on) become holes in the flat pattern, so the flat pattern always matches. Holes (the Hole feature) work on sheet metal too. Other features that change a sheet metal body are allowed, but the flat pattern can't follow them; this is shown in Body Properties and the DXF preview.

## Flatten

Click **Flatten** on the tab, or right-click the body ▸ **View Flat Pattern**. The flat pattern is shown on its own; [[Esc]] or Flatten again restores the view as it was. While it is shown, **Export DXF…** on the flat pattern banner (or right-click the view) exports it straight away. {idx:Flatten}{idx:flat pattern}

## Convert to Sheet Metal

Turns an ordinary body into sheet metal. Pick a flat face of a thin-walled body (for example a STEP export of a sheet metal part, or a shelled box), or of a knitted surface of flat faces (enter the thickness). {idx:Convert to Sheet Metal}

- RazorCAD follows that side of the sheet across every smooth edge, through flat faces and cylindrical bend faces, so the whole body is found. Each bend keeps its own radius and angle.
- Bends that run straight into each other with no flat between (rolled shapes such as a fan scroll) are joined automatically. Cut-outs in bends are kept and holes stay true circles in the DXF.
- Sharp-cornered bodies (shelled boxes) get bends of the chosen radius at every edge between two flat faces.
- A flange whose ends run right up against the material beside it, with no relief (a flange off a cross bar between the sides of a window, or off the edges of a slot), is ripped there: the flat pattern (and its DXF) has a cut line along each flange end, across the bend and on to the flange's edge, on the cut-outs layer, as the part is cut and bent. {idx:Convert to Sheet Metal, rips}
- The panel shows what was found in the body, for example "thickness 3 mm · bend radii R300, R227, R13 (inside, 3 bends)" or "4 sharp edges".
- **Use the body's thickness** and **Use the body's bend radii** are on by default. Untick either to set your own value (pre-filled with the detected one).
- A body curved other than in plain bends (a square-to-round transition or a reducer from another program, a cone) is **unrolled**: laid out flat at the neutral layer, triangle by triangle, so its flat pattern keeps every length; a ring is cut open at a seam. For a cone, click its curved face. A closed tube (bends all the way round) is unrolled the same way, cut open at a seam. A face curved both ways (a dished end, a spherical cap) can't be laid flat exactly: it is spread out as nearly as it can be (from its middle out along its profile, then relaxed so its lengths change as little as they can), and scaled to the dish's own area (pressed, the sheet keeps its volume). The note gives how far it stretches (the most over 98 % of it, and on average): use it as a blank size to press from, and check it against a trial. Cuts in such a sheet are unrolled with it (the hole is in the flat pattern); flanges, hems and corners can't be added (as on a lofted bend).
- A body that RazorCAD folded itself (for example its STEP export) gets its closed corners back as RazorCAD made them: the corner type (V cutout, closed mitre or butt), which flange covers which and the gap are worked out from the body, and the relief and curved V lines are made again exactly. Other corners are traced from the body as they are.
- After converting, the sheet's volume is compared with the body's. The feature note warns when they differ by more than 0.5 % (for example a nut or motor part that isn't sheet metal).
- A **curved surface** that is curved one way only (a cylinder, or a profile swept straight) is converted into a rolled sheet: its section is followed by smoothly joined arcs, each a bend of its own radius. **Arc fit tolerance** (default 0.05 mm) sets how closely it follows the surface. **Thickness** goes behind the surface, in front of it, or both sides.
- **Trim where the sheet would run into itself** (on by default) trims a rolled sheet back where its two ends would meet, leaving a small clearance.

## Etch Lines

**Sheet Metal ▸ Etch Lines**: pick a sketch drawn on the top or bottom face of a flat part of the sheet. Its lines, arcs, circles, splines and text are marked in the flat pattern, for etching, scribing or marking part numbers and bend marks. They go on the DXF's **ETCH** layer (DXF Settings can leave them out) and show in flat-pattern drawing views (View Properties ▸ Etch lines), clipped to the face they are on. The folded part is not changed; the etch lines show on the model as thin lines. {idx:Etch Lines}

## Sheet Metal Check

**Sheet Metal Check** lists every bend of the sheet metal body: direction, angle, inside radius, length and the straight flange on each side. It warns about flanges shorter than 3 × thickness past their bend, and holes closer than 2 × thickness + radius to a bend. {idx:Sheet Metal Check}

## Sheet metal Body Properties

Body Properties for a sheet metal body shows thickness, bend radius and K-factor, number of bends, overall flat size, flat area, mass and **quantity**, plus: {idx:cut length}

- **Cut length**: the total length of the flat outline plus every hole and cut-out, and the number of **pierces** (closed contours), for laser-cutting estimates. Also shown in the DXF part information and under flat pattern drawing views.
- **Flat pattern seen from**: top face or bottom face. The bottom face mirrors the pattern and swaps UP / DOWN bend lines and notes. Flatten, DXF export and drawing views all follow it.

## Exporting flat patterns as DXF

- Right-click a sheet metal body (tree or view) ▸ **Export Flat Pattern as DXF**, or **Export DXF** on the tab. {idx:DXF, flat pattern}
- **Export All DXF**: choose a target folder; one file per body, named after the body. Identical bodies give one file with the quantity multiplied by the count.
- **Nest Flat Patterns** {idx:nesting}{idx:Nest Flat Patterns}: lays every sheet metal body's flat pattern out on stock sheets (width × height, a margin round the sheet, a gap between parts, parts turned 90° where that fits better). Identical bodies are counted, times each body's quantity and the number of **Sets**. Parts are placed by **their true outlines** (the default: bottom left first, the biggest first, into each other's gaps and inside the holes of others) or by **the rectangles round them** (fast). They can be **turned** not at all, by 90° steps, or (by outlines) by 45° or 15° steps. The result shows each sheet and how much of it is used; **Export DXF…** writes one DXF with the sheets side by side, their outlines on layer SHEET and each part's outline and holes, named at its middle.
- Each file is shown in a **preview window** with its layer colours and line types, which can be changed there. Buttons: **Export**, **Skip This One** and **Abort Export**.
- In the preview, zoom with the wheel, pan by dragging and double-click or **Fit** to see it all. Click lines to select them ([[Ctrl]] or [[Shift]] adds, [[Shift]]+drag for a box, [[Ctrl+A]] for all), then **Delete** them, give them their own **Line type**, or move them to another **Layer** (for example make a line an etch line). **Undo** and **Restore All** put them back. These edits apply to that one export. {idx:DXF preview}
- Options: bend lines, bend notes, bend region (hidden) lines, etch lines and part information.

## DXF Settings

**DXF Settings** on the Sheet Metal tab sets the defaults for every export: layer mapping (colours and line types) and options. Defaults: **up bends red**, **down bends blue**, **etch lines yellow dashed**. **Reset to Defaults** restores them. {idx:DXF Settings}

# Fast Structure

The **Fast Structure** tab builds welded frames (weldments) from standard steel profiles: Structural Member, Trim/Extend, End Cap, Gusset, Weld Bead and Cut List. It also has a **3D Sketch** button, since frames are often laid out in 3D. {idx:Fast Structure}{idx:weldments}

## Structural Member

Pick a profile and a sketch or 3D sketch: every line and arc of it becomes a member, each its own body named after its profile. Add more sketches to the **Path** list for a frame in 3D, for example the top of a table and its legs; the joints between them are treated too. Arcs, and the bends of a 3D sketch with a bend radius, become bent members. {idx:Structural Member}{idx:profiles, structural}

| Profile | Types |
|---|---|
| Hollow sections | Square (SHS), rectangular (RHS), circular (CHS / pipe) |
| Angles | Equal and unequal angle |
| Channels and beams | Channel (PFC / UPN); I-beam (UB, UC, IPE, HEA) |
| Bars | Flat bar, round bar |

Sizes come from AS/NZS or EN/ISO tables, or enter your own dimensions.

- **Corners** where two members meet end to end: **Mitre**, **Butt** (first or second member trimmed) or **None** (members meet at the sketch points). **Trimmed ends**: square cut on the face, or coped to the other member's outside.
- A member ending on the middle of another (a T-joint), or under a corner (a table leg), is trimmed to it, square on its face. Pipes and round bars are always coped (fish-mouthed).
- **Alignment**: which point of the profile the sketch line runs through (centre, corners or edges), a profile rotation, and mirror.

## Trim/Extend

Click the members to trim on the model, then the boundary: a plane or another body. Each member is trimmed (or, with **Extend members that stop short of it**, extended) at its end nearer the boundary, either cut **square** on the boundary's face or **coped** to the boundary body. {idx:Trim/Extend}

## End Cap

Click the open end faces of tubes or pipes. A plate of the set thickness is added **on the end** (outside) or **in the end** (flush). {idx:End Cap}

## Gusset

Click two flat faces that meet at a corner, one on each member. A triangular plate fills the corner. Set the two leg lengths, the thickness, a **corner chamfer** for weld clearance, and where the plate sits along the corner (centred or to one side, plus an offset). {idx:Gusset, weldment}

End caps and gussets are bodies of their own, named by size for the cut list.

## Weld Bead

Set the weld size and click the bodies to weld (none: every weldment member). A bead runs along every line where two of them touch; each joint is its own bead body. {idx:Weld Bead}

## Cut List

**Cut List** lists identical members together, with their profile, length, end angles, quantity, total length and mass (from the bodies' materials), then plates and welds (with the total weld length). It also gives the total length of each profile. **Export CSV…** saves it for a spreadsheet. A drawing can show it as a **Cut List Table** (Drawings chapter). {idx:cut list}

## Duct Fitting

**Duct Fitting** (Weldments tab) {idx:duct fittings}{idx:flat patterns, ducts}{idx:segmented elbow}{idx:transition, round to rectangle} makes a sheet metal duct fitting of outside sizes and a sheet thickness: a **segmented elbow** (angle, centre line radius, number of gores: two end gores and the rest full ones), a **cone** (reducer: the other diameter and the length), a **round to rectangle** transition, an **offset** (two parallel round ends side by side) or a **lateral** (a branch joining a main duct at an angle). Each is a body at the origin (move it with Move Body). Its flat patterns are developed on the middle of the sheet, with a **seam allowance** along the long seam: the message lists them and their sizes, and **File ▸ Export ▸ Duct Patterns (DXF)…** writes every fitting's patterns side by side, named with their quantities. Elbow gores are worked out exactly; transitions and offsets are unfolded by triangles, every edge at its true length.

## Pipe Route and Cable

**Pipe Route** {idx:Pipe Route}{idx:routing, pipes}{idx:elbows}{idx:tees}{idx:reducers} runs a pipe along the straight lines of a sketch or 3D sketch. Where a line branches square off a straight run, an equal **tee** goes in (ASME B16.9 sizes); other branches and crosses are reported. Choose a size (DN15 to DN300, Schedule 40 walls) or a tube of your own outside diameter and wall. **Corners**: **Elbows** puts a long radius elbow at each corner (1.5 × the nominal size, or the **Bend radius** you give), each elbow a body of its own; **Bends** makes one bent tube (3 × its diameter, or your radius). **Reducer** puts a concentric reducer (to a smaller size, its B16.9 length) at the first end, the last end (in the order the lines were drawn) or both. **Flanges at the (other) ends** adds a flange ring at each open end without a reducer. The straight pipes are weldment members, so the **Cut List** gives their lengths; the message sums them up. A line too short for the elbows at its ends is reported.

**Spool Drawing** {idx:spool drawing} (Weldments tab, in a part with a pipe route) makes a drawing with one isometric view of the pipework, the cut list of the straight pipes and a **FITTINGS** table (each elbow, tee, reducer and flange, and how many).

**Cable** {idx:Cable}{idx:harness}{idx:routing, cables} sweeps a round cable or bundle along a sketch or 3D sketch (a 3D sketch spline through the points it must pass follows them smoothly). Give its **Diameter**, or the number of **Wires** and their diameter (the bundle is about 1.15 × d × √n across). The message gives the route length and the cut length with the **Slack** added.

**Harness Formboard** {idx:formboard}{idx:harness, formboard} lays the part's cables flat at their cut lengths, joined where their ends meet: each cable straight on from the one before it, branches fanned out at 45° steps. It shows the board with each cable's name and length and the points where cables meet, and **Export DXF…** writes it to lay out the board full size.

# Designing for 3D Printing

The **3D Print** tab {idx:3D printing}{idx:3D Print tab} has what a part made on a 3D printer needs: features that add a nut pocket or a printable hole in a click or two, a check of the part against what the printer can do, and an export laid out on the printer's bed. Every size it uses comes from the part's **print profile**: a printer and a material.

Its buttons run left to right in the order you work: set up (profile, orientation), add features, check, export.

## Print Profile

**3D Print ▸ Print Profile** {idx:print profile} picks the profile this part uses and edits your own. A profile holds:

| Setting | What it sets |
|---|---|
| Bed X × Y × Z | The printer's build volume: the bed check, Show Bed, Split for Printing |
| Nozzle diameter, extrusion width, layer height | The smallest walls (2 extrusion widths), the bridging steps |
| Overhang limit | How steep a face may face down, from vertical, without support (45° on FDM printers) |
| Longest bridge | The widest ceiling the printer can bridge |
| Hole clearance | Added each side to nut pockets |
| Fits: press, snug, sliding, loose | The gaps Fit Clearance uses (0.05, 0.15, 0.3, 0.5 mm to start) |
| Density, filament diameter | The mass and filament length in the check |
| Smallest hole, pin and gap | The small-feature checks |
| The material shrinks | A warning about warping on long bases (ABS, ASA, nylon) |

Four profiles come with RazorCAD: PLA, PETG and ABS on a 0.4 mm nozzle, and a resin printer. They can't be changed: **Copy…** one and change the copy. **Use for this part** keeps the choice with the part (a copy of the profile is saved in the part file too); **Make default** is the profile for parts that have none. A change to one of your profiles applies to every part that uses it.

**Printer** {idx:printer bed sizes} sets the bed from a list of popular printers (Prusa MK4 / MK4S, CORE One, CORE One L, XL and MINI+; Bambu Lab A1 mini, A1, P1S, X1C and H2D; Creality Ender-3 V3 and K1 Max; Elegoo Neptune 4 Pro; Anycubic Kobra 3). Chosen on a starting profile, it makes a copy of it for that printer, used for this part. The Prusa sizes are from Prusa's own pages; the others are from retailers' and reviewers' listings, and the dialog says so when one is chosen: check them against your printer's specifications. Typing a bed size of your own clears the printer.

**Slicer program** (Windows app): **Choose slicer program…** picks the program **Open in Slicer** starts.

## Place on Bed, Auto-Orient and Show Bed

The checks, the overhang map and the export all use the part's **build orientation** {idx:build orientation}: which way up it prints. Until you set one, the part's biggest flat outside face lies on the bed.

- **Place on Bed** {idx:Place on Bed}: select a flat face, then click it: that face goes down on the bed.
- **Auto-Orient** {idx:Auto-Orient}: tries the part with each of its outside flat faces down, and in the 26 directions of a cube's faces, edges and corners, and lists the best three: least support first, then the most on the bed, then the lowest. **Use** sets one.
- **Show Bed** {idx:Show Bed}: draws the printer's bed (a 10 mm grid) and its build volume under the part.

Features that depend on which way is up (Printable Hole, Bridging Layer, First-Layer Chamfer, Printable Overhangs) keep the orientation the part had when they were added.

## Check Printability

**Check Printability** {idx:Check Printability}{idx:printability} checks the solid bodies in their build orientation against the profile, numbers what it finds on the model, and lists it:

| Check | Fails when |
|---|---|
| Overhangs | A face facing down steeper than the overhang limit, off the bed (amber within 10° of it) |
| Bridges | A flat ceiling wider, the narrow way across, than the longest bridge |
| Walls | Thinner than 2 extrusion widths (amber under 3) |
| Holes and pins | A hole standing up under the smallest hole, a pin under the smallest pin |
| Closed hollows | A void sealed inside the part (a warning on FDM printers; a fail on resin, which is trapped in it) |
| Bed contact | Less than 5 % of the part's footprint on the bed |
| Bed fit | Bigger than the printer |
| Warping | A base over 150 mm long in a material that shrinks (a warning) |

Below the list: the support it would need (an estimate: columns from each overhang down to the part or the bed), the part's volume, its mass in the profile's material, and the filament it takes. Where a print feature fixes what was found, a button starts it: **Printable Overhangs**, **Split for Printing**, **Auto-Orient**.

## Overhang Map and Thickness Map

**Overhang Map** {idx:Overhang Map} colours the model up its build direction: green fine (or on the bed), amber within 10° of the profile's overhang limit, red over it (needs support). **Thickness Map** colours walls red under 2 extrusion widths, green to yellow above. Click again to turn them off.

## Nut Pocket

**Nut Pocket** {idx:Nut Pocket}{idx:captive nut} makes a hex pocket for an ISO 4032 nut, with the screw's clearance hole through (ISO 273 normal fit; untick it to leave it out). Click points on a face, or pick a sketch with points: each gets one. The pocket is the nut's size plus the profile's clearance each side, as deep as the nut plus the clearance (or **Pocket depth**). **Turn the flats by** turns it.

**Captive slot**: the pocket starts **Slot below the face** inside the part and a slot as wide as the nut runs out sideways past the part's edge (**Slot direction**), to slide the nut in from the side.

## Insert Hole

**Insert Hole** {idx:Insert Hole}{idx:threaded insert} makes a hole for a threaded insert pressed or melted in (heat-set): the insert's hole diameter, as deep as the insert plus a **Relief** below it, with a lead-in **Chamfer** at the top. The sizes come from a table of typical inserts; makers' sizes differ, so check yours and type its **Hole diameter** and **Insert length** if they do.

## Screw Hole for Plastic

**Screw Hole for Plastic** {idx:Screw Hole for Plastic} makes a pilot hole for a screw cut straight into the print: 0.85 × the screw's size (or a **Pilot hole** of your own), to a **Depth**, with a cap screw's **Counterbore** or a **Countersink** if wanted (ISO sizes).

## Printable Hole

**Printable Hole** {idx:Printable Hole}{idx:teardrop hole} reshapes holes lying on their side so they print without support: their top comes to a 45° point up the build direction (a **Teardrop**), or the point is cut flat at the top of the hole. Every hole whose axis lies within **Holes within this of level** is changed, or click the holes to change only those.

## Bridging Layer

**Bridging Layer** {idx:Bridging Layer} helps a counterbore or pocket printed upside down: the printer can't bridge round the smaller hole above it. Click the flat face round the hole (the counterbore's floor). **Steps**: that face is stepped up one layer at a time, first a strip as wide as the hole across the opening, then a square, so each layer bridges onto the one before. **A skin**: one layer closes the hole; drill it out after printing.

## First-Layer Chamfer

**First-Layer Chamfer** {idx:First-Layer Chamfer}{idx:elephant foot} chamfers every edge on the bed (0.4 mm to start), so the first layer, squashed wider, doesn't stick out.

## Printable Overhangs

**Printable Overhangs** {idx:Printable Overhangs} turns rounds facing down, up the build direction, into 45° chamfers of the same size, which print without support.

## Fit Clearance

**Fit Clearance** {idx:Fit Clearance} moves the faces of a part that fit against another part back by a fit's gap: **Press**, **Snug**, **Sliding** or **Loose** from the profile, or a **Gap** of your own. A flat face moves in; a pin gets thinner and a hole wider, by the gap all round.

## Print-in-Place Hinge

**Print-in-Place Hinge** {idx:Print-in-Place Hinge}{idx:hinge} makes a hinge that prints assembled. Click the straight edge it turns about: knuckles (**Knuckle diameter**) are spaced along it, the gap apart; the first, third… carry the **Pin** all along, the others are bored the gap wider all round and turn on it. Each set is a body of its own: join each to its part with **Combine**.

## Split for Printing

**Split for Printing** {idx:Split for Printing} cuts a part too big for the printer in two at a plane (choose a plane, or click a flat face), with **Dowels** across the cut: holes for dowels (**Dowel diameter**, the profile's snug fit each side, **Hole depth each side**), spaced along the cut's longest side and kept clear of its edges. Glue the halves on the dowels.

## Export for Printing and Open in Slicer

**Export for Printing** {idx:Export for Printing} writes the solid bodies as 3MF (it keeps millimetres and each body as its own object), turned into their build orientation, their lowest point on the bed, over the bed's middle. **Export STL for Printing** does the same as STL. **Open in Slicer** (Windows app) opens the last export, or a new one, in the slicer program named in Print Profile; RazorCAD only starts the program with the file.

## Calibrate Fits

**Calibrate Fits** {idx:Calibrate Fits} saves a test piece (3MF): a plate with four Ø6 holes and four pegs, 6 mm less twice the profile's press, snug, sliding and loose gaps, left to right. Print it, try the pegs in the holes, and set each fit to the gap of the peg that fitted that way. **Save the fits** keeps them in the profile (a starting profile: in a copy of it, used by this part).

# Configurations

A configuration is a variant of a part or assembly: other values for the global variables and other features suppressed in a part, other part configurations and components shown in an assembly. {idx:configurations}

## The Configurations tab

The **Configurations** tab sits next to the Feature tree and the Property panel at the top of the left panel. It lists **Default** and every configuration, the one shown ticked, each with a summary of what it changes. {idx:Configurations tab}

- **Double-click** a configuration to show it. The tree shows its name next to the part.
- **+ Add Configuration** makes a new one starting from the one shown.
- Right-click for **Show Configuration**, **Rename**, **Copy Configuration**, **Properties (Design Table)** and **Delete**.

## What a part configuration changes

- **Variable values**: each configuration can give the global variables (Tools ▸ Equations) other values.
- **Suppressed features**: while a configuration is shown, **Suppress / Unsuppress** in the tree changes that configuration only. The tree greys out what it suppresses.

## Design table

**Design Table…** in the Configurations tab (or right-click ▸ **Properties (Design Table)**, or **Configurations** on the Evaluate tab) edits all the configurations in one table. The table can be copied to and pasted from a spreadsheet as CSV. {idx:design table}

## Configurations in assemblies

Assemblies have the same tab. While an assembly configuration is shown, these change that configuration only: a component's part configuration, **Hide / Show**, **Suppress** (a suppressed component is left out, with its mates) and a mate's Suppress or value. See the Assemblies chapter for how components use part configurations.

# Assemblies

An assembly places parts and other assemblies as **components** and holds them together with **mates**. Assemblies are saved as **.rasm** files and open in a tab of their own. {idx:assemblies}{idx:.rasm}

## Starting an assembly

**File ▸ New Assembly**, or **New Assembly** in the start window. Every assembly has the standard **Front, Top and Right Planes** and the **Origin** at the top of its tree. They show in the view as a part's do (the eye in the tree, **View ▸ Show Planes**), and mates can use them; they stay where they are. {idx:assembly, planes}

The **Assembly** tab of the ribbon holds Insert Components, Standard Parts, Equations, Assembly Hole, Assembly Cut, Mate, Fix, Float, Hide Component, Suppress, Open Part, Edit in Context, Exploded View, Positions, Explode / Collapse, Motion Study, Bill of Materials, Interference Check, Collision Detection, Speed Mode and Zoom to Fit.

## Inserting components

**Insert Components** lists the parts and assemblies open in other tabs, or **Browse for a Part or Assembly…** takes a .rcad or .rasm file. {idx:Insert Components}

- The first component is **fixed** at the origin; the others are placed beside what is there.
- If the part has configurations, you choose which one to use. Right-click a component later to switch it to another configuration. The same part can be in the assembly several times in different configurations.
- The assembly keeps a copy of each part, refreshed from its tab or file whenever you come back to the assembly, so edit a part and the assembly follows.
- Several instances of one part share it: it is built once and drawn once.

## Standard parts

**Standard Parts** (Assembly tab, or **Insert ▸ Standard Parts…**) adds parts made to size from their standards: {idx:standard parts}{idx:fasteners}

- hex bolts (ISO 4017) and socket head cap screws (ISO 4762), M3–M24, in the standard lengths; hex nuts (ISO 4032) and washers (ISO 7089);
- inch hex bolts (ASME B18.2.1), socket head cap screws (ASME B18.3), hex nuts (ASME B18.2.2) and SAE flat washers, 1/4" to 1", with UNC threads and inch lengths;
- socket set screws (ISO 4026), dowel pins (ISO 8734), round head rivets (ISO 1051), circlips for shafts and bores (DIN 471 / 472), parallel keys (DIN 6885 A) and 6000 / 6200 series ball bearings.

Each is an ordinary part with its threads as cosmetic threads, so it builds fast. Choose its material: steel, stainless, brass or aluminium. The same type, size, length and material is one part however many times it is used, so the bill of materials counts them.

**Select a hole first** (its round face or edge) and the size is picked to fit it (a clearance or tapped hole for bolts, the bore for a bearing, the shaft for a key), the length to suit the hole, and the part goes into the hole at the end facing you, mated to it (Concentric, plus Coincident on the face round the hole). For a bolt or screw:

- **Washer under the head**, and **washer and nut on the far side**: the whole set is mated, and the length is picked for it (a 10 mm plate: M8 × 25).
- **All matching holes**: the same part or set goes into every hole of the same size parallel to the selected one, in one go.

A hole that ends on a curved face (a cross hole in a round bar) gets a seat plane of its own, which follows the hole when the part changes.

## Mates

Click **Mate** ([[M]]), then two faces, edges or vertices on different components (or a standard plane), choose the type and click ✔. The panel stays open for the next mate; [[Esc]] closes it. {idx:mates, assembly}

| Mate | Holds |
|---|---|
| **Coincident** | Faces, edges or points together |
| **Concentric** | Axes in line |
| **Parallel** / **Perpendicular** | Directions |
| **Tangent** | A face touching a round face |
| **Distance** / **Angle** | At a set value |
| **Lock** | One component fixed to another |
| **Gear** | Two gears turning together: pick their cylinders (pitch circles) |
| **Rack Pinion** | A pinion turning as a rack slides: pick the pinion's cylinder and a straight edge or the flat face of the rack |
| **Screw** | On one axis, the second component advancing the **pitch** along it per turn it makes relative to the first (a nut on a lead screw) |
| **Width** {idx:Width mate} | The second component centred between two faces of the first: pick a face of each, then the first component's other face, then the second's (two parallel faces each: a tongue in a slot) |
| **Slot** {idx:Slot mate} | A pin (a cylinder's axis) or a point kept the set distance from a straight edge (0: on it; the slot's side edge with the pin's radius), free to slide between the edge's ends and stopped there |
| **Path** {idx:Path mate} | A point (a vertex, an edge's middle, a sphere's centre) kept on a curved or circular edge of another component, free to move along it |
| **Cam** {idx:Cam mate} | A follower kept touching a cam's curved edge (a plate cam's outline): a roller (a cylinder's axis) its radius from the edge, seen along the roller's axis, or a point at the set distance. Guide the follower with another mate (a Slot or a Concentric on a pivot) and turn the cam: the follower rides on it |
| **Symmetric** {idx:Symmetric mate} | Two faces, edges or vertices kept mirror images of each other about a plane: pick them, then the plane (or a flat face) between them |

- Flat faces count as planes; cylinders, cones and circular edges as axes; spheres and vertices as points.
- Each mate is shown applied while you choose. **Flip** swaps Aligned / Anti-Aligned (or the side for Distance and Tangent). When the alignment chosen from how the faces sit can't be reached, the other one is used.
- **Limit** (Distance and Angle) {idx:Limit mate}: free between a **Minimum** and a **Maximum** instead of one value (a slide with end stops, a door that opens 0 to 110°). Inside the limits the component moves freely; dragged past one, it stays there exactly.
- A mate that conflicts with the others is refused with a message.
- A mate keeps its faces and edges by their geometry, not only by their number in the part. When a part gets a new feature or a dimension moves a face, the mate stays on the same face. A mate whose face or edge is gone gets a red **!** in the tree ("1 mate lost a face"). **Tools ▸ Fix Mates…** lists them with Edit, Suppress and Delete. {idx:Fix Mates}

### Gear and rack-pinion mates

These relate one component's motion to another's, from where they are when the mate is made, so set the teeth in mesh first. Hold each gear on its axle with the usual mates (Concentric and Coincident); the gear mate then takes one more degree of freedom. {idx:gear mate}{idx:rack and pinion mate}

- **Gear**: turn one gear and the other turns the other way, in the ratio of their radii. **Ratio** is how many turns entity 2 makes per turn of entity 1; change it to the teeth ratio if the cylinders are not the pitch circles. **Reverse the direction** is for an internal gear, where both turn the same way. The tree shows it as for example "Gear1 1:2".
- **Rack Pinion**: turning the pinion slides the rack along the edge (or face) picked, and sliding the rack turns the pinion. **Rack travel per pinion turn** starts as the pinion's circumference (π × diameter). **Reverse** changes the direction.
- They follow turns of any size made step by step, as when you drag a gear. One jump of more than half a turn can't be told from a turn the other way.

## Moving components

Left-drag a component to move it, [[Alt]]+drag to turn it. It moves only as its mates allow. The view turns, pans and zooms as in a part (see Navigating the 3D View). {idx:assembly, moving components}

Selecting works as in a part and follows the **selection filter**: with no filter a click picks the vertex, edge, face or plane under the cursor; with the Bodies filter it picks whole components. [[Ctrl]]+click adds or takes away. Right-click a face, edge or vertex for **Mate…** and the component's commands; whatever is selected goes into the mate. Dragging a component moves it, whatever is selected. {idx:assembly, selecting}

## Fasten All Holes

**Fasten All Holes** (Assembly tab) finds every stack of lined-up round holes through two or more components (tick **Also holes through one component only** for single ones too) and puts a fastener in each: the type you choose (hex bolt, socket head cap screw, inch sizes…), its size fitted to the holes, its length to the whole stack, with a washer under the head and a washer and nut on the far side if ticked, each mated in place (concentric, seated on the stack's outer faces). Stacks that have a fastener already are left alone, so it can be run again after adding parts. {idx:Fasten All Holes}{idx:smart fasteners}

## Component patterns and mirrors

**Component Pattern**, **Circular Component Pattern** and **Mirror Components** (Assembly tab) copy the selected component (or the components of the selected faces and edges) {idx:component pattern}{idx:mirror components}:

- **Component Pattern**: along X, Y, Z or a selected straight edge or axis, a spacing and a number of instances, and optionally a second direction.
- **Circular Component Pattern**: round X, Y, Z or a selected axis (a cylinder, a circular edge), a total angle (equal spacing) or the angle between copies.
- **Mirror Components**: about the YZ, XZ or XY plane or a selected flat face. The copy is placed as the mirror image, the part itself the same way round (for parts that are the same both ways round, such as screws, pins and brackets symmetric about the plane).

The copies are components of their own (in the bill of materials, mateable), fixed, and follow their seed when it moves. The pattern is listed in the tree: double-click it to change it, or delete it with its copies.

## Collision detection

**Collision Detection** on the Assembly tab (or **Tools ▸ Collision Detection Off / Show Collisions While Dragging / Stop at Collisions While Dragging**) checks for parts running into each other as you drag. {idx:collision detection}

- **Show**: the parts that collide turn red while you drag, and the status bar names them.
- **Stop**: the dragged component (and what its mates carry along) stops where it meets the other part, right against it.
- Faces that only touch (mated faces) are not collisions, nor is a shaft in a hole of its size, nor a screw in a nut or tapped hole (threads are cosmetic, so the screw is its full diameter in a bore of about its minor diameter). Parts that already overlap when the drag starts are left out.
- It works from the parts' display meshes, so it keeps up with the mouse. **Interference Check** gives the exact overlap volumes.

## The assembly tree

- Each component shows **(f)** when fixed or **(-)** while still free to move, its configuration, and an eye to hide or show it.
- The **Mates** folder lists the mates; right-click one for **Edit**, **Flip**, **Suppress** or **Delete**.
- Right-click a component for **Mate…**, **Open Part** (or double-click it), **Edit in Context…**, **Fix / Float**, **Hide / Show**, **Suppress / Unsuppress**, **Insert Another Instance**, **Rename** and **Delete**.
- **Make Flexible** (a sub-assembly component) {idx:flexible sub-assembly}: its parts move in this assembly as its own mates let them (a hinge opening, a slide moving), solved with this assembly's mates on them; where they end up is kept with this component, so the sub-assembly itself and its other uses do not change. **Make Rigid** puts it back as one piece. A component fixed inside it stays fixed only when the sub-assembly component is fixed.
- **Number Parts** (Assembly tab) {idx:part numbers}{idx:Number Parts} gives each part and sub-assembly a **Part Number** property in the order of the bill of materials: a prefix, a first number, a step and a number of digits (P-0001, P-0002…). Those with a part number keep it unless you ask to number them again. Save parts kept in files of their own to keep their numbers there.
- **Edit in Context** {idx:Edit in Context}{idx:top-down design} opens the part with the other parts you tick brought into it as transparent **context bodies** (the features *Context: …*), where they are in the assembly from it. Design the part to fit them: sketch on their faces, convert their edges, extrude up to them. Context bodies are references only: they are left out of the part where it is used (in the assembly, drawings, the bill of materials and exports). The context stays up to date: each time the part comes to the front with the assembly open, context bodies whose parts changed, changed configuration or moved are brought in again (a part taken out of the assembly has its context feature suppressed). Right-click a context feature ▸ **Update Context** to bring them all in again. Delete or suppress the context features when they are no longer needed. Save the part to update the assembly.
- Undo and redo work in the assembly.

## Sub-assemblies

An assembly can hold other assemblies as components. **Insert Components ▸ Browse for a Part or Assembly…** takes a .rasm file, and STEP assemblies keep their sub-assemblies when they open as an assembly. An assembly can't go inside itself. {idx:sub-assembly}

- A sub-assembly is kept whole, with its own parts, placements and configurations, and moves, hides, suppresses and explodes as one. Clicking any of its parts picks it.
- Mates can use the faces, edges and vertices of the parts inside it.
- In the tree, ▶ opens a sub-assembly to show its components. Double-click one, or right-click the sub-assembly ▸ **Open Sub-assembly**, to change it in its own tab; the changes come back to the assembly.

## Equations shared with the parts

**Assembly ▸ Equations…** (also on the Assembly tab) holds the assembly's own variables, for example `base = 6` and `thickness = 2*base`. A variable that **drives the parts** sets the variable of the same name in every part that has one, through the sub-assemblies, so related parts are sized together from the top. {idx:equations, assembly}{idx:top-down design}

- The table shows each variable's value, the parts it drives and a **Drives the parts** check box (off for a variable used only to work out others).
- The values go into the assembly's copies of the parts, so the assembly, its drawings, the BOM and exports use them. They are applied again when a part is read again from its file.
- **Update Open Parts** writes them into the parts open in tabs too, to be saved there.

## Assembly holes and cuts

**Assembly Hole** and **Assembly Cut** (Assembly tab, or the Insert menu) make holes and cuts in the assembly, through every component they pass. {idx:Assembly Hole}{idx:Assembly Cut}

1. Click points on a flat face of a component. More points on the same face make more holes; clicking another face starts again.
2. Set the hole: simple, counterbore, countersink or tapped, a standard size (ISO 273 close, normal or loose fit) or a custom one. The first component gets the hole as chosen, the ones behind it a plain hole of the drill size. **Tap the last component** makes the last one tapped for the size. A cut is a rectangle: width, length and angle.
3. Choose **Through all** or a depth. **Components cut** lists the components it passes through; untick one to leave it out.
4. **Fasteners**: hex bolts or socket head cap screws put into each hole as it is made, with washers and a nut on the far side if wanted, as long as the stack they hold (to a standard length) and mated in the hole. Into a tapped last component, a screw goes about one diameter into the thread, without a nut.

The parts' own files are not changed: each component cut gets the feature in its copy of the part, so the assembly's drawings (hole callouts too), BOM and exports have the holes. The holes stay with the component they were clicked on: move a component and its holes are worked out again. The tree's **Assembly Features** folder lists them; right-click one to edit, suppress, rename or delete it. Fasteners put in a hole are kept when the hole is deleted.

## Exploded views

**Exploded View** on the ribbon (or **Insert ▸ Exploded View…**) spreads components apart for display; the model and its mates stay put. {idx:exploded view}

1. Click components to pick them (click again to drop one).
2. Pick a direction: ±X, ±Y, ±Z, or along a face's normal.
3. Drag the picked items along the direction, or type the distance, then click **Add Step**. **Spread Out** spaces the picked items out along the direction, one step each.
4. Click a step to change it, ✕ to delete it. **Explode lines** (dashed, from each item's place to where it is shown) can be switched off.

The tree's **Exploded Views** folder lists them. Double-click one to explode or collapse it (animated); right-click for Explode / Collapse, Animate, Edit, Rename and Delete. The **Explode / Collapse** button on the ribbon does the same for the last one. Dragging a component, adding a mate or editing collapses the view first. Exploded views are saved with the file.

## Motion studies

**Motion Study** (Assembly tab) shows how an assembly moves. Choose a driver: {idx:motion study}

- **turning a component** about the axis of one of its mates (360°, for example);
- **sliding a component** along one of its mates' axes or faces;
- **changing a Distance or Angle mate's value** from where it is to a new one.

The motion is worked out step by step and the mates carry the other components along, gear and rack-pinion mates included. **Play / Stop** ([[Space]]), back to the start, a slider to go through the steps, the number of steps, the duration and **Loop**. Where the mates can't follow, the panel says at which step.

**Detect collisions** (on for new studies) checks every step: parts that collide show in red as the motion plays, and the panel names the first collision and its step. **Stop at the first collision** ends the motion at the step before it. {idx:clearance} **Clearance** between two components (choose them in the panel) works out, at every step, the least distance between them from their display meshes, and the panel gives the least of all and its step (in red when they touch).

✔ keeps the study in the assembly's **Motion Studies** folder: double-click one to play it; right-click to edit, rename or delete it. Closing the panel puts the assembly back as it was: a motion study never moves the assembly itself.

## Interference Check

**Interference Check** (Assembly tab, or **Tools ▸ Interference Check…**) finds where components overlap. Each overlap shows in red and is listed with its two components (inside sub-assemblies as "Sub-assembly ▸ Part") and its volume. Faces that only touch, such as mated faces, are not counted, and nor are the bodies of one multi-body part against each other. An exploded assembly is collapsed first, so the check is of where the mates put the parts. {idx:Interference Check, assembly}

## Bill of Materials

**Bill of Materials** lists the parts with their quantities and materials: one row per part and configuration used, with suppressed components left out. It is indented: a sub-assembly's parts are listed under it (1.1, 1.2…), with the quantities in one of it. **Copy as CSV** or **Save CSV…** takes it to a spreadsheet. {idx:Bill of Materials}

- **Columns**: click a column heading to change what it shows (an item number, quantity, part, material, file, configuration, any custom property, mass, cost, or values typed in), insert a column left or right, move, rename or remove it. Typed values are edited right in the table. The columns are kept with the assembly and are part of undo; **Default Columns** goes back to the usual ones.
- **Mass and cost**: **Mass** and **Total mass** come from each part's material and volume; **Cost** and **Total cost** from a part's **Cost** property (for example 12.50, $3 or R12,50). A **TOTAL** row adds up the quantity, mass and cost; a sub-assembly adds up its parts. {idx:mass, bill of materials}{idx:cost}

## STEP assemblies

Opening a STEP file that holds an assembly asks whether to open it **as an assembly** or **as one part** (see Importing in the Working with Files chapter). As an assembly, each part of the file becomes a part, each sub-assembly a sub-assembly, and each component is placed, fixed, where the file places it, with the names and colours from the file. {idx:STEP, assembly}

**File ▸ Export ▸ STEP…** in an assembly saves the whole assembly as one STEP file with its structure: each part once, in the configuration used, every component placed where it is and named after it, sub-assemblies kept as assemblies, and the parts' colours. Suppressed components are left out. {idx:STEP, assembly export}

## Saving parts as separate files

When an assembly holds parts or sub-assemblies that are only inside it (as a STEP assembly does when it opens), Save asks how to save them: {idx:assembly, saving parts as files}

- **Save Parts as Separate Files** saves each part as a .rcad file and each sub-assembly as a .rasm file in the assembly's folder, named after them. The assembly (and each sub-assembly) then uses those files, so each part can be opened and changed on its own and the change shows in the assembly. A part used in several places is one file. If files of those names are already there, you are asked before they are replaced.
- **Save as One File** keeps everything inside the assembly file. You are not asked again, except on Save As.

## Collect Files

**File ▸ Collect Files…** (in an assembly) {idx:Collect Files}{idx:copying an assembly} copies the assembly with everything in it into one folder: each part and sub-assembly a file of its own (as the assembly has it now), the assembly last, using those files. Names can be given something **before** and **after** them (e.g. `P1-`), to start a variant of the design or send it all to someone. The assembly open here is left as it is.

## Big assemblies

Each part an assembly builds is kept in the model cache (`%LOCALAPPDATA%\RazorCAD\modelcache`). Opening the assembly again shows unchanged parts straight from there, and the kernel only builds parts that changed, so a large layout reopens in seconds. Parts are built side by side in several geometry kernels at once, as many as the PC's processor threads and memory allow, and each shows as soon as it is built. Each part is sent to the graphics card once and placed at every component that uses it, so moving, hiding or exploding components is instant. {idx:assembly, opening quickly}

**Speed Mode** (Assembly tab, or **View ▸ Speed Mode**) is for very large assemblies: the parts are shown from simplified display meshes, with far fewer triangles to draw and keep in memory. The faces and edges stay the same, so mates, measuring, picking and collision detection work as before. A component you select is loaded in full; turning speed mode off shows everything in full again. It is saved with the assembly, and a large assembly suggests it in the status bar. Drawings, exports and Interference Check always use the exact geometry. {idx:Speed Mode}

# Drawings

RazorCAD makes 2D engineering drawings of parts and assemblies, saved as **.rdrw** files and opened in their own tab. {idx:drawings}{idx:.rdrw}

## Starting a drawing

- **Start window ▸ New Drawing**, or **File ▸ New Drawing**, opens the set-up dialog (below) and then an empty sheet.
- **File ▸ Make Drawing from Part** (in a part), or **Make Drawing from Assembly** (in an assembly): after the set-up dialog, places the standard three views at a scale that fits, clear of the title block.
- A drawing can show assemblies as well as parts: every component is drawn where it sits, through its sub-assemblies, in the configurations shown; suppressed and hidden components are left out. Big assemblies (more than about 200 solids) are drawn fast from the parts' display meshes: lines, circles and arcs as exact as the 3D view's, and where an edge turns hidden to about two thousandths of the view's size. A site layout of thousands of solids then takes seconds a view instead of many minutes. In a view's properties, **Hidden lines** chooses Automatic, Exact or Fast; section and flat-pattern views are always exact. {idx:drawing, fast hidden lines} {idx:drawing, of an assembly}

Drawings are opened, saved and listed in the recent files like parts.

## The sheet and its template

The default template is A3 with an ISO 5457 frame (zones and centring marks) and an ISO 7200-style title block: title, drawing number, material, scale, size, units, projection symbol, drawn / checked / approved, date, mass, company, revision, sheet n of m and general tolerances. Sheet sizes A0 to A4, landscape or portrait. {idx:title block}

## Drawing templates

A **drawing template** (.rdrt file) keeps a drawing's set-up: its sheets (size, orientation, scale, projection), the drawing settings (text height, decimals…), the title block's standing entries (company, drawn / checked / approved by, finish, tolerances, revision) and notes placed on the sheet. Views, parts and part-specific entries (title, drawing number, material, mass, date) are not kept. {idx:drawing templates}{idx:.rdrt}

- **File ▸ Save as Template…** in a drawing saves one, by default to `Documents\RazorCAD\Templates`. Opening a .rdrt file edits the template in its own tab.
- **The New Drawing dialog** lists your templates (from the Templates folder, or **Browse…** for one anywhere) and the standard ones: A4 portrait and landscape, A3, A2, A1 and A0 landscape, and A3 and A4 in third angle projection. Set the drawing name, title, drawing number, drawn by and company, and the first sheet's size, orientation, scale and projection. Tick **Use this template as my default** to have it chosen first next time. Double-click a template to create the drawing at once.
- **Change Template…** (File menu, Sheet tab, or right-click the drawing in the tree) switches an existing drawing to another template. Views, dimensions and annotations stay; company, tolerance and finish come from the new template, and the old template's notes are replaced. Undo goes back.
- **Company sheet formats**: a template can carry its own border, title block and logo in place of the standard ISO one, used on sheets of its size and orientation. Its text shows the drawing's properties, and can be set in a font installed on the PC; PDF exports embed the font. Drawing Properties lists the title block's own fields.

Changing the projection (Change Template or Sheet Properties) lays the views out again for the new projection, so a top view stays a top view.

## Working on the sheet

| Action | How |
|---|---|
| Zoom | Mouse wheel |
| Pan | Middle or right drag, or left drag on empty paper |
| Fit the sheet | [[F]] |
| Move views and annotations | Drag them |
| Edit | Double-click a view for its properties, a dimension or note to edit it |
| Menus | Right-click |
| Delete | [[Del]] |
| Undo / Redo | [[Ctrl+Z]] / [[Ctrl+Y]] |

## View Layout tab

| Command | What it does |
|---|---|
| **Model View** | Pick an open part or assembly, or browse for its file (.rcad or .rasm), pick the orientation (front, back, top, bottom, left, right, isometric, dimetric, trimetric or flat pattern) and click on the sheet. Then move around it to place projected views. |
| **Standard Views** | Three views laid out for first- or third-angle projection |
| **Projected View** | A view aligned with its parent |
| **Flat Pattern** | A sheet metal body unfolded (see below) |
| **Section View** | Horizontal, vertical or **At an angle** (degrees from horizontal, counter-clockwise) cutting line, hatched cut faces, A-A labels and arrows, flip; an angled section looks square to its line and can be placed anywhere |
| **Detail View** | A circle with a letter, 2:1 by default |
| **Auxiliary View** | Looks square at an inclined edge, so it shows its true shape |
| **Break** | Leaves out the middle of a long part; dimensions across the break keep the true length |
| **Crop View** | Shows only the area you draw round |
| **Broken-out Section** | Click a view, then the corners of an outline round what to show inside; click the first corner again to close it and give the **depth** from the front of the model. The material inside the outline is taken away to that depth, the faces cut there hatched, the outline drawn thin. Right-click the view ▸ Remove Broken-out Section takes it away |
| **Compare With** | This drawing's sheets against another drawing open in RazorCAD (an earlier version, say), sheet by sheet: lines only in this one in red, only in the other in green, in both in grey {idx:drawing compare} |
| **Update Views** | Re-reads the parts and redraws the views |

{idx:Model View}{idx:Standard Views}{idx:Projected View}{idx:Section View, drawing}{idx:Detail View}{idx:Auxiliary View}{idx:broken view}{idx:Crop View}{idx:broken-out section}

A broken or cropped view can be put back to whole from its right-click menu. Section views hatch each body or component with its own angle and spacing.

Views are hidden-line projections computed by the geometry kernel.

## View properties

Click a view to open its panel: {idx:view properties}

- Orientation, changeable after placing (also to and from Flat Pattern; projected and section views made from it are removed when it becomes a flat pattern, and [[Ctrl+Z]] brings them back).
- Display style: hidden lines removed, hidden lines visible, or wireframe; tangent edges and cosmetic threads on or off.
- **Exploded** (a view of an assembly that has exploded views): shows the view exploded as one of them. The components are where that exploded view moves them, the view keeps its place on the sheet, and its projected, section, auxiliary and detail views follow. Balloons on it pick the moved parts. {idx:exploded view, drawing}
- **Alternate position** (a view of an assembly): draws the assembly again as a **position** kept in it, in thin phantom lines (long dash, two short), over the view: a lid open, a lever at its other end. Keep positions in the assembly with **Assembly ▸ Positions** (move the components, e.g. by changing a mate, keep the position, then put them back). {idx:alternate position}{idx:positions, assembly}
- Sheet scale or a custom scale; labels.
- **Rotate View**: −90°, +90°, 180° and 0° buttons and an angle box (degrees, counter-clockwise). Section lines, detail circles and annotations turn with the view.

Aligned views slide only along their alignment. Deleting a view deletes the views made from it.

## Flat pattern views

A flat pattern view shows a sheet metal body unfolded with its outline and holes, bend lines (chain lines) with notes (UP / DOWN, angle, radius), optional bend region lines, and its flat size, thickness, number of bends and cut length underneath. It can be dimensioned (bend lines too) and exported to PDF. If the part has several sheet metal bodies, pick the body in the view properties. Instead of notes, the view can show a **bend table**: the bend lines numbered B1, B2… and a table of direction, angle and inside radius under the view. Forms, cross breaks and tabs and slots show as in the DXF. {idx:flat pattern view}{idx:bend table}

## Annotation tab

| Command | How |
|---|---|
| **Dimension** | Click a line for its length, a circle for its diameter (an arc: radius), two points, lines or circles for the distance between them (two lines at an angle: the angle), then click where the text goes. Horizontal, vertical or aligned depends on where you place it. Prefix, suffix, tolerance and override text can be set. |
| **Auto Dimension** | Dimensions the selected views, or every view on the sheet (see below) |
| **Check Drawing** | Lists what the drawing still lacks (see below) |
| **Note** | Click on the sheet; click an edge first to add a leader |
| **Baseline Dimension** | Click the base edge or point, then each point or edge to dimension from it; the dimensions stack one above the other |
| **Ordinate Dimension** | Click the origin, then where the values line up, then the points to dimension |
| **Chamfer Dimension** | Click the chamfer edge and an edge next to it, then place the text ("3 × 45°") |
| **Hole Callout** | Click a hole. The callout gives its size and depth from the Hole feature (counterbore, countersink, tapped thread and tap drill) or its cosmetic thread, and how many of the same holes the view shows, for example "4× Ø6.6 THRU ALL / CBORE Ø11 DEEP 6.5". |
| **Datum Feature** | A datum letter in a box, with a triangle on the feature |
| **Geometric Tolerance** | A feature control frame: one of the 14 characteristic symbols, tolerance with Ø zone and material condition, and up to three datums |
| **Surface Finish** | A surface finish symbol with its roughness |
| **Weld Symbol** | Fillet, square, V, bevel or plug weld on a reference line with an arrow to the joint; arrow, other or both sides; all-around, field weld and tail |
| **Center Mark** | Click circles or arcs |
| **Centerline** | Click two lines (or two points); the centerline runs between them |
| **Revision Table** | Rows edited in one dialog; the latest revision goes into the title block |
| **Table** | A general table {idx:table, drawing}: a title, rows (one a line, cells split by `|`, or pasted from a spreadsheet with tabs), the first row a bold header if ticked; each column as wide as its widest cell. `{material}`, `{title}` and the drawing's other properties fill in. Double-click it to change it or delete it |
| **Cut List Table** | The cut list of the part in the selected view (see the Fast Structure chapter); it updates when the part changes |
| **Hole Table** {idx:Hole Table} | The holes of the selected view (circles seen end on) tagged in it, a letter for each size, largest first, numbered from the bottom left (A1, A2… B1), with their X and Y from the view's lower-left corner and their size; it updates when the part changes |
| **Balloon** | Click a part in a view, then where the balloon goes. The number is that part's item in the bill of materials, found from the part under the click (in a sub-assembly, the sub-assembly's item). Keep clicking for more; [[Esc]] ends. Where the part can't be told, it asks for the number. Right-click a balloon ▸ **Item Number…** to change it. |
| **BOM Table** | The bill of materials of the drawing's assembly: ITEM, QTY, PART and MATERIAL, at the top right of the sheet. Drag it anywhere; right-click it to show the sub-assemblies' parts (indented). It follows the assembly. Right-click a column to change what it shows (any field, custom property, mass, cost or typed values), insert, move, rename or remove it; double-click a typed value to edit it. **Columns…** (right-click the table, or double-click it) has everything in one dialog. With mass or cost columns a TOTAL row is added. |

Datum features, geometric tolerances, surface finish and weld symbols can each have a leader. Right-click one ▸ **Edit…** to change it. {idx:dimensions, drawing}{idx:note}{idx:center mark}{idx:baseline dimension}{idx:ordinate dimension}{idx:Hole Callout}{idx:GD&T}{idx:geometric tolerance}{idx:datum}{idx:surface finish}{idx:weld symbol}{idx:revision table}{idx:Cut List Table}{idx:balloon}{idx:BOM Table}

### Auto Dimension

**Annotation ▸ Auto Dimension** (also **Insert ▸ Annotations**) adds the dimensions the selected views need, or every view on the sheet's: the overall sizes, outermost; hole diameters, one per size ("4× Ø9"); arc radii; and hole positions. Each size is given once in the drawing, and nothing is added that a view's own dimensions already give. Only views looking along the part's axes are dimensioned. {idx:Auto Dimension}

It asks how, and keeps your choices for next time:

- **Positions**: baseline (each from the view's edge), chain (edge to hole to hole on one row) or ordinate (values from the view's bottom left corner).
- **Tolerance**, for example ±0.1, added to the new lengths and diameters.
- **Spread labels that would overlap**.
- **Add**: which kinds (overall sizes, hole diameters, hole positions, arc radii).

Everything it adds is one undo step; drag the dimensions to tidy them up.

### Check Drawing

**Annotation ▸ Check Drawing** (or **Tools ▸ Check Drawing…**) lists what the drawing still lacks before it goes out, most important first: {idx:Check Drawing}

- **Title block**: fields left empty. Title, drawing number, drawn by, date, revision and material are to fix; checked and approved are noted, to be filled in at sign-off.
- **Dimensions per view**: part views with no dimensions (a view whose sizes all show in other views is only noted), crowded views, annotations whose view was deleted and dimensions that lost what they measured.
- **Undimensioned features**: overall sizes, hole diameters, radii and hole positions that no dimension gives. A size given in one view is not asked for again in the part's other views, a hole callout gives a hole's diameter, and hole positions count in baseline, chain or ordinate style.

Click an item to show its view or annotation. **Add Missing Dimensions** puts in what Auto Dimension would; **Title Block…** opens the drawing's properties.

### DXF drawings on the sheet

**Insert ▸ DXF Drawing…** places a DXF file's lines, circles, arcs, polylines, ellipses, splines and texts on the sheet as one item, in the middle of the frame at full size or scaled down to a standard scale that fits. Drag it, right-click ▸ **Scale…**, or delete it; it prints and exports with the sheet. {idx:DXF, into drawings}

## Sheet tab

- **Sheet Properties**: size, orientation, scale, first or third angle. {idx:sheet properties}
- **Title Block** (Drawing Properties): title block fields, text height and decimals.
- **Units**: click **MMGS / IPS** in the status bar. An inch drawing gives lengths in inches with three decimals and its title block says "in"; angles are not converted. {idx:drawing, units}
- **Change Template**: see Drawing templates above.
- **Add Sheet**: drawings can have several sheets, shown as tabs under the sheet.
- **Export PDF**: vector PDF, one page per sheet. {idx:PDF export}
- **Export DXF**: the current sheet as a DXF file, with layers for visible, thin, hidden and centre lines, text and hatching. A sheet format's logo is left out. {idx:DXF, drawing export}

## Views follow the part

Views and dimensions follow changes to the part or assembly, whether it is open in another tab or read from its file. A copy of the part is kept in the drawing so it still opens if the part file is missing.

## Not yet available

DWG import and export: DWG is a closed format with no free reader or writer that could run in RazorCAD, so drawings are exported, and DXF files placed, as DXF, which practically every CAD program reads and writes.

# Evaluate and Tools

## Measure

**Evaluate ▸ Measure**, **Tools ▸ Measure…** or the view's right-click menu. Click vertices, edges, faces, planes or sketch lines; with two items picked it shows the distance between them plus dX, dY and dZ. Use the body filter ([[B]]) to pick whole bodies. Sizes are in the document's units. {idx:measure}

- **Snap To**: besides vertices, a click picks **sketch points**, the **midpoints of edges** and the **centres of circles and arcs** (a hole's centre too); each can be turned off. As you move, the point a click would pick is marked on the model with its name.
- The items picked are numbered **1** and **2** on the model.
- **Keep the first item** measures from the first item to each next click (a third click replaces the second, not the first).
- **Measured** lists the distances measured so far, most recent first.

## DFM Check

**Evaluate ▸ DFM Check** checks the solids for machining {idx:DFM check}{idx:manufacturability}: **sharp inside corners** (a concave straight edge between flat faces: a cutter leaves its radius there), inside rounds smaller than the **smallest cutter radius**, holes smaller than the **smallest hole** or deeper than a number of times their diameter, hole sizes that are not standard drills (whole or half millimetres up to 20, whole millimetres above: reamed, bored or clearance holes are reported as notes), and very small faces (often import slivers). Each finding is listed and numbered on the model; **Clear the marks** removes them. For thin walls use Thickness Analysis, for moulded parts Draft Analysis and Undercut Check, for sheet metal Sheet Metal Check.

## 3D Annotations

**Evaluate ▸ 3D Annotation** puts product and manufacturing information on the model itself (model based definition) {idx:3D annotations}{idx:MBD}{idx:PMI}{idx:GD&T}: a **Note**, a **Dimension** between two points (its value measured, or given) with its tolerances, a **Geometric tolerance** (a feature control frame: the characteristic, a Ø zone if ticked, the tolerance and the datums), a **Datum** letter or a **Surface finish** (Ra). Fill in the dialog, then click the point on the model it is about (two points for a dimension). Each shows as a label with a leader to its point and follows the view. **Tools ▸ 3D Annotations…** lists them, to delete them or hide them all. Exported to STEP (whole part), datums, geometric tolerances and dimensions go into the file as semantic PMI (AP242), each on the face it points at, for programs that read AP242 PMI; notes and surface finishes go in as properties of the part. A STEP file with PMI opened in RazorCAD shows its datums, tolerances and dimensions as 3D annotations.

They are saved with the part, and a **STEP export** of the part carries them: each annotation is written as a property of the part with its kind, its text and the points it refers to (the file is AP242). Programs that read STEP properties show them; they are not semantic GD&T that a measuring machine program can use directly. {idx:STEP, AP242}

## Tolerance Stack-Up

**Evaluate ▸ Tolerance Stack-Up** (also in an assembly's ribbon, and Tools ▸ Tolerance Stack-Up…) works out a gap from a chain of dimensions in one direction {idx:tolerance stack-up}{idx:worst case}{idx:RSS}. Each row is a dimension: its nominal size, its upper and lower tolerance (both as positive numbers: 50 +0.1 / −0) and whether it **adds to** or **takes from** the gap. The results update as you type: the gap's nominal and mean, its **worst case** limits (every tolerance at its limit together) and its **statistical** limits (root sum of squares: what most assemblies see when the parts vary independently), checked against the gap required (at least / at most). The share column shows which tolerances matter most. Stack-ups are kept in the part or assembly; New stack-up adds another.

## Mass Properties

**Evaluate ▸ Mass Properties** shows mass, volume, surface area and centre of mass. It adds up every body with its own density and lists the bodies. A body with no material uses 1.00 g/cm³. {idx:mass properties}

## Interference Check

**Evaluate ▸ Interference Check** finds where the solid bodies of a part overlap. It lists each pair with its overlap volume and shows the overlaps in red. Assemblies have their own (see the Assemblies chapter). {idx:Interference Check}

## Surface analysis

These displays colour the model to show the quality of its faces. Click the button again to turn its display off. {idx:surface analysis}

| Command | Shows |
|---|---|
| **Zebra Stripes** | Reflected stripes on every body. Across a smooth join the stripes run on without a kink. |
| **Curvature** | Bodies coloured from blue (flat) through green and yellow to red (tightest). The status bar gives the radius red stands for. |
| **Draft Analysis** | Choose a pull direction (an axis or a selected face's normal) and the draft needed. Faces turn green with enough draft, yellow where they need more, and red with draft the other way. |
| **Thickness Analysis** | Give the thinnest and thickest walls allowed. Each point is coloured by the wall thickness measured from it straight in through the material: red thinner than allowed, blue thicker (sinks and voids in a moulding), green to yellow between, grey where no wall was found. The status bar gives the thinnest and thickest walls and the share of the surface outside the limits. |
| **Undercut Check** | Choose a pull direction. Each point is looked at along it and against it: green can be pulled out along it (one mould half), blue against it (the other), red neither way (an undercut, needing a side action or a change). The status bar gives the share of the surface undercut. |

{idx:Zebra Stripes}{idx:Curvature}{idx:Draft Analysis}{idx:Thickness Analysis}{idx:Undercut Check}

## Configurations

**Evaluate ▸ Configurations** opens the design table (see the Configurations chapter).

## Equations and global variables

**Tools ▸ Equations…** holds global variables that can be used in any dimension or feature value. Example: `width = 120`, then set a depth to `width/4`. Each row shows the value it evaluates to; invalid or duplicate names are flagged. {idx:equations}{idx:global variables}

Every value field accepts:

| Item | Examples |
|---|---|
| Operators | `+ - * / ^ %` and parentheses |
| Variables | Any name from Equations |
| Trigonometry (degrees) | `sin cos tan asin acos atan` |
| Other functions | `sqrt abs min max round floor ceil pow` |
| Constants | `pi` |
| Units of length | `2in`, `30 mm`, `1.5cm`, `2ft`, `(w/2)*in` (see Units) |

A value may start with `=`. Variable names start with a letter or underscore and can't be a function name.

## Macros

**Tools ▸ Macros…** writes, runs and saves JavaScript macros that drive RazorCAD. {idx:macros}

- In parts they can sketch (lines, rectangles, circles, arcs, polygons), extrude, cut, revolve, add any feature, change or delete features, set equations and the material, and rebuild. In assemblies and drawings they can add, change and remove components, mates, views and annotations.
- Anywhere they can run any command by its name in the command search, ask you for a value, and run other macros.
- The **API** button lists what a macro can use; a sample macro shows the idea.
- A macro's changes are one undo step. Errors show their line, which is selected in the editor. [[Ctrl+Enter]] runs; [[Ctrl+S]] saves.

**Tools ▸ Record Macro** records what you do until **Stop Recording Macro** (or the red "● Recording macro" in the status bar): the features you add, change, delete or reorder, the commands you run, and in assemblies and drawings what you change there (parts inserted, components moved, mates, views, annotations, sheets). The recording opens in the Macros dialog to be saved or edited. Items made during the recording are kept in variables and others are found by name, so a recording plays back into another part, assembly or drawing.

Saved macros are in the Tools menu (**Macro: name**) and the command search, so they can have keyboard shortcuts. **Import…** / **Export…** share them as .js files.

> Warning: Macros can do anything RazorCAD can. Run only macros you trust.

## Edit Material

**Tools ▸ Edit Material…** (or the Material item in the tree) sets the part material. See Appendix B for the list. {idx:Edit Material}

# Modelling with Claude

RazorCAD can build features from a plain-language description using Anthropic's Claude. {idx:Claude}{idx:Ask Claude}

## Setting up

Open **Tools ▸ Claude Settings…** (or the Claude tab ▸ **Claude Settings**) and choose how RazorCAD reaches Claude: {idx:API key}{idx:Claude subscription}

- **My Claude subscription (Claude Code on this PC)**: each request goes through the Claude Code command-line program installed on this PC, signed in to your own Claude Pro or Max plan. It counts toward that plan's usage limits, with no separate bill. The dialog shows where Claude Code was found, its version and whether it is signed in; **Sign In…** starts the sign-in, which you finish in the browser, and **Check Again** reads the status again. Claude Code runs with no tools, settings or memory, from an empty folder, so it sees only RazorCAD's modelling guide and your request.
- **An Anthropic API key**: enter your own key (create one at console.anthropic.com ▸ API Keys; requests are billed to that account). The key is stored on this PC in `%APPDATA%\RazorCAD\claude.json` and is only sent to api.anthropic.com. **Remove Key** deletes it.

Then choose a model: Opus, Sonnet or Haiku.

## Ask Claude panel

Open it with the **Claude** tab ▸ **Ask Claude**, or **Tools ▸ Ask Claude…**.

- Describe a part or a change. Claude adds the features to the tree; each answer is **one undo step**.
- If the features don't build, Claude is told the error and corrects it, up to two more tries.
- Claude sees the feature list and body sizes of the part, not the picture.
- **New Conversation** (or **New chat** in the panel) starts fresh; the part stays as it is.
- The model can be switched in the panel.

## RazorCAD Part Builder on claude.ai

A companion page on claude.ai lets you describe a part, see the feature list with sketch previews, and download it as a .rcad file to open in RazorCAD. It uses the same modelling guide as the in-app panel.

# Troubleshooting

## Crash reports

RazorCAD writes a crash report whenever something goes wrong, to `%APPDATA%\RazorCAD\crashes\<date_time>_<kind>\`. Open the folder with **Help ▸ Open Crash Reports Folder**. The start window mentions new reports. The newest 30 are kept. {idx:crash reports}

| File | Contents |
|---|---|
| `report.json` | The kind of failure, the error message and stack trace, what RazorCAD was doing (mode, Property panel, sketch tool, selection, feature errors) and system information |
| `session.log` | The recent actions of the session, newest last |
| `part.rcad` | The part that was open, so the problem can be reproduced |

Kinds of report: `ui-error`, `kernel-error`, `kernel-worker-crash`, `python-exception`, `native-crash` and `unexpected-shutdown` (a session that ended without closing normally, found at the next launch).

## Reporting a problem

**Help ▸ Report a Problem…**, or **Report on GitHub…** in the start window's crash notice, turns a crash report (or a plain description, without a crash) into a GitHub issue. The report holds RazorCAD's version, Windows, what went wrong and the last lines of the session log; you see the whole text first and can edit it. Your user name and folders are taken out, and the part you were working on is not included. **Open GitHub Issue** opens RazorCAD's new-issue page in your browser with the text filled in; nothing is sent until you submit it there. **Copy Text** copies it instead. {idx:Report a Problem}

## Speed on your PC

How many geometry kernels work at once comes from the PC RazorCAD runs on: one per processor thread beyond two (left for the window and the rest of the PC), and about 1 GB of free memory each beyond 2 GB, read from Windows when RazorCAD starts; at least 2, at most 16. Assemblies build their parts side by side in them, drawings draw their views in them, and each open part keeps one (up to half of them). Kernels that are idle for a few minutes are stopped to give their memory back. A big imported STEP file's bodies are meshed by several kernels at once when that is quicker (64 bodies with 6784 faces: 1.8 s instead of 5.4 s). Crash reports note the figures, for example "up to 12 at once (24 threads, 14.8 GB free)". {idx:geometry kernels}{idx:performance}

Each open part's kernel is **multi-threaded**: Open CASCADE splits booleans (cuts, joins and the features built on them) and meshing over several threads, and faces and edges are read and boxed in parallel too. The first part you open gets all the processor threads but two (at most 22); each further part, assembly or drawing kernel gets half the threads beyond two, from 2 to 8. On a PC with 4 or 5 threads the first part gets all but one and the others one thread; with 2 or 3 threads the first part gets two (about 30 % quicker than one on two cores) and the others one. Parts full of cuts and large imports gain most: 16 test parts rebuild about three times faster than on one thread (on a PC held to 4 threads, 9.2 s instead of 16.3 s). The browser version at razorcad.com/app does the same in a current browser (the website serves it cross-origin isolated, which shared memory needs). The session log says which kernel started ("Geometry kernel ready: multi-threaded, 22 threads"). {idx:multi-threaded kernel}

**Cuts made together**: a run of cut features (extrude and revolve cuts with a blind, mid-plane or through end, holes other than tapped ones, and patterns and mirrors of cuts) is made in one boolean instead of one after another, each on a body with more faces than the last. The cuts wait until a feature needs the body as it really is (a fillet, a hole ending on a face, anything that picks model geometry) or the rebuild ends. The Giant Golfball (178 dimples) rebuilds in 2.5 s instead of 4.7 s, with exactly the same result. Editing the last cut feature makes only its own cut again: the rest is remembered. {idx:cuts made together}

Editing a feature meshes again only the faces and edges it changed, and a part reopened from the model cache picks up where it left off without being built again.

## Common problems

| Problem | What to do |
|---|---|
| A fillet or projected edge loses its edge after a big change | Edges are found again by their geometry and the faces beside them (see References that follow edits). If one is still lost, **Tools ▸ Fix References** lists it: Edit to re-pick it, or Remove missing. |
| A mate moved to the wrong face, or shows a red ! | Mates find their faces again by geometry. A face that is gone is listed in **Tools ▸ Fix Mates**: edit the mate to pick it again. |
| A sketch on a model face doesn't follow the face | Sketches on faces are stored as fixed planes. Use a reference plane driven by an equation when that matters. |
| Project Edges can't see a sketch | It only sees visible sketches earlier in the history. Show the sketch first. |
| An STL body can't be filleted | STL bodies with thousands of faces can't be filleted or chamfered and don't offer pickable edges. |
| A fillet won't blend across two touching bodies | Combine the bodies first. |
| Open fails with a file filter error | Fixed in 0.9.0-beta. Update RazorCAD. |
| Unsaved work after a crash | Reopen the part and accept the auto-save recovery. |

## Settings and data files

| Location | Contents |
|---|---|
| `%APPDATA%\RazorCAD\recent.json` | Recent files list |
| `%APPDATA%\RazorCAD\claude.json` | Claude settings, API key and model |
| `%APPDATA%\RazorCAD\prefs.json` | Toolbar layout, icon size, your keyboard shortcuts, whether the tour was taken, and other preferences |
| `%APPDATA%\RazorCAD\update.json` | The update check: on or off, when it last looked, a version you chose to skip |
| `%APPDATA%\RazorCAD\crashes\` | Crash reports |
| `%LOCALAPPDATA%\RazorCAD\modelcache\` | Built models of parts and assemblies, and the geometry after each feature, for fast opening and editing, one folder per version of the geometry kernel (up to 1 GB; safe to delete) |
| `Documents\RazorCAD\Templates\` | Your drawing templates |
| `Name.autosave.rcad` | Auto-save, next to the part file |

# For Developers

## Rebuilding the executable

```
python -m pip install pywebview pyinstaller pillow
build.bat
```

`build.bat` bundles `app/` (including the 23 MB OpenCascade WebAssembly kernel) and `razorcad.py` into `RazorCAD.exe` with PyInstaller. If RazorCAD is open, the running copy is renamed to `RazorCAD.old.exe` and the new build is used from the next launch. {idx:build.bat}

`installer\build_installer.bat` builds `RazorCAD.exe` and then `RazorCAD-Setup.exe`. Set the version in `version.txt` first.

## Code signing

Both builds sign RazorCAD.exe, the thumbnail DLL and the setup once a code-signing certificate is set up; until then they say "Not signed" and carry on. `tools\sign.py --check` shows how signing is set up. `installer\SIGNING.md` explains how to get a certificate and set it up (a certificate on a USB token or in Windows by its thumbprint, a .pfx file, or a cloud signing service). {idx:code signing}

## Regression tests

```
python tests/run_tests.py
```

This rebuilds the test parts in `tests/parts` with the real geometry kernel in headless Microsoft Edge. It compares every body's volume, area, faces and edges (and flat patterns) with `tests/expected.json`, and the drawings of six test parts with their stored line counts and sizes. It also runs checks done as a user does them: sketching, dimensioning and extruding, drawings, assemblies, mates, references, standard parts, collisions, assembly features, macros, accessibility and more. It needs Python's playwright package and exits with 1 on any difference. `--update` stores new expected results, `--only` runs some of them, and `--make-parts` makes the test parts again from `tests/make_parts.js`. On a PC with 12 or more processor threads the run is split over several pages side by side (`--jobs N`; `--jobs 1` runs everything in one page): about 27 s instead of 65 s on 24 threads. See `tests/README.md`. {idx:regression tests}

- **Timings**: every run's times are kept per machine in `tests/perf-history.json` (not in git). A test markedly slower than its usual time is listed under **Performance**; `--perf` lists every time and `--perf-strict` fails the run on a slowdown.
- **On GitHub** the tests run for every push and pull request (`.github/workflows/tests.yml`), split over 6 machines side by side (`--shard I/N`, shared out by the times in `tests/test-weights.json`): some 15 minutes.

## Releases

Pushing a version tag (for example `v0.14.0-beta`, matching `version.txt`) runs `.github/workflows/release.yml`: the tests, then RazorCAD.exe and the setup are built and a draft release is made with the setup, its read-me, checksums and notes from `CHANGELOG.md` (`tools/release_notes.py`). A version that already has a release is left alone. See `installer/RELEASING.md`. {idx:releases}

## The geometry kernel builds

`app/vendor/replicad` holds two builds of the same Open CASCADE bindings: `replicad_single` (one thread) and `replicad_multi` (threads, with shared memory). Both are built from source: Open CASCADE 8.0.1 with two speed patches (the same results), opencascade.js 3.1.0 (Emscripten 6.0.5) with whole-program optimisation, replicad's bindings (commit a0bc495) with RazorCAD's additions, and `tools/native/surface-patch.cpp` (`tools/native/README.md`); `tools/patch_surface_kernel_loader.py` adjusts their loaders. The kernel worker loads the multi-threaded one when the app asks for more than one thread and the page is cross-origin isolated: the desktop app's server, `serve.py` and the tests' server send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for that. The website takes files up to 25 MiB, so `tools/build_web_app.py` publishes a bigger kernel in parts, which the worker joins. {idx:kernel builds}

## The website and the browser version

`python tools/build_website_docs.py` builds the online manual (`website/docs`) from this manual's source and the browser version (`tools/build_web_app.py`). The browser version is built in its own folder, `RazorCAD Web` next to the project folder, with both kernels (`website/_headers` serves it cross-origin isolated, so it runs the multi-threaded one where the browser can), and copied from there into `website/app`; it carries the geometry kernel's signature so the browser keeps stored models per kernel.

`python tools/check_site.py` checks the website as it is served (razorcad.com, or another address): its pages, the browser version's isolation headers, and the browser version itself in headless Edge (it starts, and a multi-threaded kernel builds a part). GitHub runs it after each push that changes the website (`.github/workflows/site-check.yml`).

## Working on the UI

Run `python serve.py` and open http://localhost:8765/ in a browser. In that mode files are downloaded instead of saved through dialogs. Set the `RAZORCAD_DATA_DIR` environment variable to keep a test run's recent-files list separate from your own. {idx:serve.py}

## Project layout

| Path | Purpose |
|---|---|
| `RazorCAD.exe` | The application (built by build.bat) |
| `razorcad.py` | Desktop shell: native window, file dialogs, auto-save (pywebview) |
| `app/js/main.js` | Application controller: documents, commands, selection, files |
| `app/js/ui.js` | Menus, Command ribbon, Feature tree, Property panel, dialogs |
| `app/js/model.js` | Feature definitions, undo history, materials, sample part |
| `app/js/kernel.worker.js` | Geometry kernel worker: replays the history with OpenCascade |
| `app/js/sketcher.js`, `sketchmodel.js`, `solver.js` | Sketch mode, sketch data and the constraint solver |
| `app/js/sketch3d.js`, `sketch3dmodel.js` | 3D sketches |
| `app/js/sheetmetal.js` | Sheet metal features and flat patterns |
| `app/js/weldments.js`, `profiles.js` | Fast Structure members and the profile tables |
| `app/js/assembly.js`, `asmview.js`, `explode.js` | Assemblies, their display and exploded views |
| `app/js/drawing*.js`, `drawtemplates.js`, `pdf.js`, `dxf.js` | Drawings, templates, sheet formats, PDF and DXF export |
| `app/js/claudespec.js` | Modelling guide used by Ask Claude |
| `app/js/collide.js`, `asmfeatures.js`, `asmcuts.js`, `motion.js`, `stdparts.js` | Collision detection, assembly holes and cuts, motion studies, standard parts |
| `app/js/macros.js`, `drawcheck.js`, `autodim.js`, `compare.js` | Macros, Check Drawing, Auto Dimension, Compare With |
| `app/js/a11y.js`, `machine.js`, `kernelclient.js` | Keyboard use and screen-reader labels; how many kernels the PC can run; the kernels |
| `kernelsig.py` | The geometry kernel's signature (the model cache is kept per kernel) |
| `Manual/` | This manual: source, build script and change tracking |

# Appendix A: Keyboard and Mouse Reference

## General

| Action | Keys |
|---|---|
| New / Open / Save | [[Ctrl+N]] / [[Ctrl+O]] / [[Ctrl+S]] |
| Save As | [[Ctrl+Shift+S]] |
| Import STEP / STL | [[Ctrl+I]] |
| Undo / Redo | [[Ctrl+Z]] / [[Ctrl+Y]] |
| Rebuild | [[Ctrl+B]] |
| Delete feature or entity | [[Del]] |
| Accept / cancel Property panel | [[Enter]] / [[Esc]] |
| Edit a feature | Double-click it in the tree |
| Search commands | [[Ctrl+K]] or [[/]] |
| The manual (at the feature being edited) | [[F1]] |
| Your own shortcuts | Help ▸ Customize Shortcuts |
| Focus to the panel, ribbon or view | [[F6]] / [[Shift+F6]] |
| In a tree: move / close or open / open the item / first or last | [[↑]] [[↓]] / [[←]] [[→]] / [[Enter]] / [[Home]] [[End]] |

## View

| Action | Keys |
|---|---|
| Zoom to fit | [[F]] |
| Front, Back, Left, Right, Top, Bottom, Isometric | [[Ctrl+1]] … [[Ctrl+7]] |
| Normal To | [[Ctrl+8]] |
| Rotate in steps | Arrows 15°, [[Shift]] + arrows 90° |
| Pan in steps | [[Ctrl]] + arrows |
| Roll | [[Alt]] + ← / → |
| Hide body under cursor / show hidden body under cursor | [[Tab]] / [[Shift+Tab]] |

## Selection filters

| Filter | Key |
|---|---|
| Faces / Edges / Vertices / Bodies | [[X]] / [[E]] / [[V]] / [[B]] |
| Clear filters | [[F5]] |

## Sketch

| Tool | Key |
|---|---|
| Select | [[S]] |
| Line | [[L]] |
| Rectangle | [[R]] |
| Circle | [[C]] |
| Arc | [[A]] |
| Spline | [[N]] |
| Polygon | [[P]] |
| Trim | [[T]] |
| Dimension | [[D]] |
| Project Edges | [[E]] |
| Offset | [[O]] |
| Construction Geometry | [[Q]] |
| Delete | [[Del]] |
| End tool, then exit sketch | [[Esc]] |
| Tool wheel | Hold the right button (or drag with it) |

## 3D sketch

| Action | Keys |
|---|---|
| Next drawing plane (XY → YZ → ZX), or back from a picked plane | [[Tab]] |
| Draw off the X/Y/Z directions | Hold [[Ctrl]] or [[Shift]] |
| Draw on a plane or flat face | [[Ctrl]]+click it |
| Length dimension: true length → ΔX → ΔY → ΔZ | [[Tab]] while placing |
| Tools | Same keys as 2D sketches: [[S]], [[L]], [[C]], [[A]], [[N]], [[P]], [[D]], [[T]], [[E]], [[Q]] |

## Assembly

| Action | Keys |
|---|---|
| Mate | [[M]] |
| Move a component / turn it | Left-drag / [[Alt]]+drag |
| Motion study: play / stop | [[Space]] |
| Zoom to fit | [[F]] |

# Appendix B: Materials

| Material | Density (g/cm³) |
|---|---|
| Plain Carbon Steel | 7.80 |
| AISI 304 Stainless | 8.00 |
| 6061 Aluminum Alloy | 2.70 |
| Brass | 8.50 |
| Copper | 8.96 |
| Ti-6Al-4V | 4.43 |
| ABS Plastic | 1.04 |
| PLA Plastic | 1.24 |
| Nylon 6/6 | 1.14 |

A body or part with no material uses 1.00 g/cm³ for mass calculations.

# Appendix C: Manual Revision History

| Date | Software version | Changes |
|---|---|---|
| 2026-10-29 | 0.20.0-beta | A 3D Print tab: print profiles with a list of popular printers, the build orientation (Place on Bed, Auto-Orient, Show Bed), Check Printability, Overhang and Thickness Maps, Export for Printing laid out on the bed and Open in Slicer; Nut Pocket, Insert Hole, Screw Hole for Plastic, Printable Hole, Bridging Layer, First-Layer Chamfer, Printable Overhangs, Fit Clearance, Print-in-Place Hinge, Split for Printing and Calibrate Fits. Intersection Curve through splines, reference points on curved edges and faces, outward shells, G2 fillets on circular edges, several loft connectors, Freeform on faces of any outline, and dished ends laid out flat in sheet metal. |
| 2026-10-29 | 0.19.0-beta | A new geometry kernel (k14): Delete and Resize Fillet, Defeature and Delete Face Heal take faces out exactly, and STEP files carry datums, geometric tolerances and dimensions as semantic PMI. The manual inside RazorCAD ([F1]), docked or in a window of its own. Freeform faces, G2 fillets, Boundary Surface tangent or curvature continuous to faces. Plastic parts and moulds (bosses, snap hooks, core and cavity, parting surfaces, side cores, runners), direct editing, library features, pipe routes with tees, reducers and spool drawings, duct fittings with flat patterns, cables and harness formboards. Assemblies: Edit in Context, slot, path and cam mates, clearance along a motion study, flexible sub-assemblies, Where Used, Number Parts. Drawings: hole tables, broken-out sections, Compare With. 3D annotations, Render, revisions, true-shape nesting, glTF export, point clouds. Extrude and Revolve: face profiles, second sides, draft and Intersect. |
| 2026-10-28 | 0.18.2-beta | The browser version never uses an older cached geometry kernel after an update. Line and Centerline infer parallel and collinear relations, and Project and Intersection can pick from one chosen sketch. The updater checks that the new version installed before it restarts RazorCAD. STEP products with their own solids as well as child parts keep those solids. A repeated Measure on a curved face answers at once. |
| 2026-10-28 | 0.18.1-beta | Starts reliably on PCs with few processor threads. On PCs with 4 or 5 threads the open part's geometry kernel is multi-threaded (rebuilds about 40 % faster). Guided lofts with CAD guide constraints build up to 16 times faster. The kernel chapter for developers brought up to date. |
| 2026-10-28 | 0.18.0-beta | A faster geometry kernel: full rebuilds about three times quicker, edits about twice. Guided sweeps and lofts, loft end conditions up to G2, guide constraints. Filled Surface with G0, G1 or G2 on each edge. Sketch offsets, tangency where lines meet splines. Extrude and Revolve: profiles picked in the view, two sides, start offsets. Reference plane, axis and point constraints; planes and points along paths. |
| 2026-10-26 | 0.17.4-beta | Settings window. Variable fillet points dragged along their edges. Assemblies keep their own up axis. Sketch Fillet where a spline meets a line or an arc. Feature folders, and patterns of them. Developed sheets: the neutral layer on the inside of each face's curve. An experimental Linux build. |
| 2026-10-26 | 0.17.3-beta | Lofted Surface guide curves (rails). Patterns of more features, faces and bodies. Measure snaps (sketch points, midpoints, centres), numbered picks, keep the first item, history. Refused relations say why. Guided Loft follows its guides more closely; Bézier profile reversal and the Lofted Surface closed check fixed. Contributions merged: parametric sketch patterns with a side panel, draggable dimension labels, Equal Curve Length and Coincident Midpoints relations, loft profiles and guides picked on the model, grouped sketch tools and slots, parameter autocomplete. |
| 2026-10-25 | 0.17.2-beta | Edge-Flange: corners corner to corner with square ends by default (each flange to the other's inside face, gap 0.5 mm, bends in straight V cuts); mitred kept as an option; no split or sliver faces at the corners. Up axis Y or Z per part (View, status bar, the Origin's right-click menu). Variable fillets: points along the edges. Rips as one cut line. Sketch box selection, splines to degree 7, Sketch Fillet on arcs, sketch patterns along a curve, plane references from sketch entities. An example part and a tutorial. One file dialog at a time. |
| 2026-10-25 | 0.17.1-beta | Edge-Flange: flanges meet corner to corner by default. Control-point splines: closed smoothly, weights, control points inserted and removed, splines converted. Loft guide curves move holes and thin walls too. Convert to Sheet Metal: flanges flush against the material beside them ripped; a wrapped blade unrolled. |
| 2026-10-24 | 0.17.0-beta | Control-Point Spline (degree 1 to 5, its polygon dimensioned and constrained). Midpoint of an arc. Reference planes: through an edge and a point, through two edges, at a distance along an edge, tangent to a cylindrical face; placement for every plane. Loft guide curves. Convert to Sheet Metal: square-to-round transitions, cones and closed tubes unrolled, exact corners. Section views saved with the part. STEP, IGES and mesh files opened from Windows are imported. |
| 2026-10-21 | 0.16.0-beta | Section view: from a selected face or plane, a drag arrow, in assemblies, two or three planes at once. The view turns about the point under the cursor. Big imports kept and read back quicker; Measure quicker on sheet metal. |
| 2026-10-21 | 0.15.0-beta | Speed on your PC: the multi-threaded geometry kernel and cuts made together. For Developers: the kernel builds; the browser version built in its own folder. |
| 2026-10-21 | 0.14.0-beta | New sections: RazorCAD in your browser, Update Now, Language and theme, Using the keyboard, Properties, Compare With, IGES import, Etch Lines, Standard parts, Collision detection, Equations shared with the parts, Assembly holes and cuts, Motion studies, Speed Mode, assembly STEP export, Auto Dimension, Check Drawing, DXF drawings on the sheet, Macros, Reporting a problem, Speed on your PC, Releases and the website. Updated: bill of materials columns, mass and cost; fillets set at each vertex and setback corners; curvature-continuous 3D splines and loft continuity; the fonts that come with RazorCAD; the model cache; tests. |
| 2026-10-20 | 0.13.0-beta | New sections: Updates, Getting Started Tour, Search commands, Your own keyboard shortcuts, Units (inches), Cosmetic Thread, References that follow edits, Fix References, gear and rack-pinion mates, Fix Mates, assembly Interference Check, Code signing and Regression tests. Drawings add Balloon and BOM Table, exploded views and units; Hole callouts give cosmetic threads. Faster opening (the geometry after each feature is kept) and faster patterns of added features. |
| 2026-10-20 | 0.12.0-beta | Brought up to date with the software. New chapters: 3D Sketches, Airfoils, Fast Structure, Configurations and Assemblies. Sheet Metal adds Sheet Metal Extrude, Lofted Bend, Transition / Reducer, Miter Flange, Hem, Sketched Bend, Jog, Cross Break, Tab and Slot, Forming Tools, Gusset, gauge tables and Sheet Metal Check. Drawings add templates, auxiliary, break and crop views, baseline, ordinate and chamfer dimensions, hole callouts, GD&T, surface finish and weld symbols, revision and cut list tables, bend tables and DXF export. Surfaces add lofted, swept, filled, boundary and ruled surfaces, trim, extend, untrim, delete and replace face, split line, projected and composite curves, flatten surface, convert to solid and repair mesh. Also: new sketch tools, Hole, Draft, Rib, Dome, Move Face, Scale, new patterns, appearances, exploded views, interference check, surface analysis, OBJ and 3MF, toolbar customising and the Claude subscription option. Feature and tool names follow the software's new names. |
| 2026-10-13 | 0.9.0-beta | First edition. Covers parts, sketching, gears, solid features, bodies, surfaces, reference geometry, the feature tree, sheet metal (including Convert to Sheet Metal with detected thickness and bend radii), drawings, evaluate tools, Ask Claude, troubleshooting and developer notes. |
