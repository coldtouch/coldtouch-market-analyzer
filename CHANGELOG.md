# Changelog

All notable changes to the Coldtouch Market Analyzer will be documented in this file.

## [Unreleased]
### Added
- **Market Browser Search Button**: Added a dedicated `Search` button to the Market Browser tab and updated its filtering logic to wait for the button click or an `Enter` keystroke, rather than automatically querying upon every single keyboard press or dropdown change.
- **Updated Item Database**: Downloaded a fresh dictionary of items from the Albion Data Project community repository. `items.json` now includes over 1,500 newly added items, including the entire line of Avalonian weapons (Dawnsong, Daybreaker, Astral Aegis, etc.), which were previously missing from the local database.
- **Market Flipping Enchantment Filter**: Added an enchantment filter dropdown to the Market Flipping tab, allowing scans to be narrowed down to specific enchantment levels (.0 to .4).
- **Market Browser Quality Filter**: Added a dropdown to filter the best Buy and Sell prices for a selected quality (Normal to Masterpiece).
- **Market Browser Sort Option**: Added a dropdown to sort the displayed items by Name (A-Z), Lowest Buy Price, or Highest Sell Price.
- **Market Browser Autocomplete**: The search bar in the Market Browser now features an autocomplete dropdown to quickly find specific items by name.
- **Git Push Automation**: Automated pushing changes to the GitHub repository upon request.
- **Crafting Profits Overhaul**: Redesigned the Crafting Profits tab. You can now search for any specific item to view a detailed breakdown of its crafting process. Includes accurate per-city material cost comparisons, optimal selling city suggestions, and dynamic adjustments for Focus, Specialization, Mastery, City Production Bonuses (Resource Return Rate), and Station Fees.
- **Expanded Recipe Database**: Auto-generated 4,455 exact crafting recipes (T3-T8, all armors, weapons, materials, bags, and capes) mapped to the game's actual material patterns to accurately power the Crafting Calculator.
### Fixed
- **Pagination Bug**: Fixed an issue where changing the page in the Market Browser would reset the view to page 1 because the filter logic reset the page unconditionally.
- **Enchanted Material IDs**: Fixed a bug where enchanted refined materials (like 5.3 Metal Bars) were generated with the incorrect API ID format, causing them to return no prices. They now correctly use the `_LEVEL` suffix.
- **Buy & Sell Order Clarity**: Updated the Crafting Profits tables to explicitly show both "Insta-Buy" and "Buy Order" costs for materials, as well as distinguishing "Insta-Sell" and "Sell Orders" for the finished product.
