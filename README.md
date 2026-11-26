# Knapsack

Editor, tester and note creator for [Knap](https://knap.md/) templates.

## Testing a template

Using a knap template, `Templates/Recipe.knap`:

````markdown
---
{{ author | wikilink | yaml_property:"author" }}
{{ servings | yaml_property:"servings" }}
{{ url | yaml_property:"source" }}
---

{{ title | h1 }}

{{ description | blockquote }}

## Ingredients

{{ ingredients | table:("Ingredient", "Quantity") }}

## Instructions

{{ instructions | list:numbered }}
````

Add a `knapsack` block to a note with data for the fields in the knap template:

````markdown
```knapsack
template: Templates/Recipe.knap
data:
  author: Eric Kim
  servings: 8
  url: https://example.com/gochujang-cookies
  title: Gochujang caramel cookies
  description: Chewy sugar cookies with a ribbon of spicy caramel.
  ingredients:
    - [Unsalted butter, 1/2 cup]
    - [Dark brown sugar, 1/4 cup]
    - [Gochujang, 1 tablespoon]
    - [All-purpose flour, 1 1/2 cups]
  instructions:
    - Mix the caramel ingredients until smooth.
    - Make and chill the cookie dough.
    - Swirl in the caramel, shape, and bake.
```
````

| Setting        | Meaning                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `template`     | Vault path or `[[wikilink]]` of the template file                                                                                 |
| `data`         | Variables for the template, or the path or `[[wikilink]]` of a note whose properties to use                                       |
| `render`       | `true` shows the preview as formatted Markdown instead of its source. What is copied or made into a note is the source either way |
| `preview`      | `false` hides the generated Markdown                                                                                              |
| `fields`       | Inputs that turn the block into a form; see below                                                                                 |
| `outputFolder` | Folder for created notes; made if missing. Setting it adds a **Create note** button, with or without `fields`                     |
| `query`        | A VaultQuery SQL query; each row becomes a note. See [Notes from a query](#notes-from-a-query)                                    |
| `existingFile` | With `query`: `skip` (default) leaves a note that already exists, `overwrite` replaces its content                                |

Properties from `yaml_property` are written the way Obsidian writes them: text is quoted only where YAML needs it. The [Knap playground](https://knap.md/playground) quotes all text; the values are the same.

### Creating a note

Set a `outputFolder` and `fields` types. Each field becomes an input, and the result can be made into a note or copied. 

````markdown
```knapsack
template: Templates/Recipe.knap
outputFolder: Recipes
data:
  servings: 8
fields:
  title: text
  author: text
  servings: number
  url: text
  description: text
  instructions: list
```
````

| Field type               | Input                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `text`                   | One line of text                                            |
| `number`                 | A number                                                    |
| `checkbox`               | A toggle                                                    |
| `date`                   | A date picker                                               |
| `list`                   | One input per item. Select **Add item** for another.        |
| `note`                   | A note, chosen from suggestions; the template gets its name |
| `notes`                  | Several notes, separated by commas                          |
| `json`                   | Text read as JSON, for a list of lists or named values      |
| `[first, second, third]` | A dropdown of those choices                                 |

Defaults can be provided in `data`. New notes are named after `title` or `name` field

#### Suggestions from a property

A `text` or `list` field suggests values other note's property values. To take suggestions from a different property, name it after the type:

````markdown
```knapsack
template: Templates/Recipe.knap
fields:
  author: text                # values of the author property
  stars: text Rating          # values of the Rating property
  course: list Meal type      # property names may contain spaces
  tags: list                  # tags from properties and from note text
```
````

#### Notes from a folder

`note` and `notes` suggest every note in the vault. Name a folder after the type to offer only its notes: `author: note People`.

#### Required fields

End a field's name with `*` to require it: `title*: text`. A form with an empty required field cannot be copied or made into a note.

### Notes from a query

With the [VaultQuery](https://community.obsidian.md/plugins/vaultquery) plugin, `query` runs a SQL query and applies the template to each row. A row's columns are the template's variables, over any values in `data`.

````markdown
```knapsack
template: Templates/Recipe.knap
outputFolder: Recipes
fields:
  title*: text
  ingredients: json
  instructions: list
query: |
  SELECT r.name AS title, r.author, r.servings,
    (SELECT json_group_array(json_array(i.name, i.quantity)) FROM ingredients i WHERE i.recipe = r.name) AS ingredients,
    r.steps AS instructions
  FROM recipes r
```
````

The block lists the rows by note name, each marked as ready, already existing, or having a problem. Select a row to preview its note, or move through the list with the arrow keys. The buttons above the list show only the rows of one kind.

**Create note** makes the note for the selected row and opens it. The other button makes every note that is ready.

A note is named after the row's `title` or `name` column. A row is not made into a note when it has neither, when it shares its name with another row, when a required column is empty, or when the template reports an error.

The query runs when the block is drawn. Reopen the note to run it again. `{this.*}` placeholders refer to the note holding the block.

#### Column types

A query returns text and numbers. `fields` gives the type of a column, and a name ending in `*` requires a value in every row. With a query, `fields` draws no inputs.

| Field type | A column's value becomes                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- |
| `list`     | The items of a JSON array, or the lines of other text. An empty column is an empty list  |
| `notes`    | As `list`, with commas also separating items                                             |
| `json`     | The JSON value: a list of lists for a table, or named values                             |
| `number`   | A number                                                                                 |
| `checkbox` | True for `1`, `true` or `yes`                                                            |

A list property in VaultQuery's `notes_with_properties` is already a JSON array. `json_group_array()` builds one from joined rows; add `FILTER (WHERE item.name IS NOT NULL)` to it under a `LEFT JOIN`, which otherwise gives a list holding one empty item.

#### Notes that already exist

A row whose note is already in the output folder is skipped, so the buttons are safe to press again after new rows appear. `existingFile: overwrite` replaces the content of those notes, from either button.

### Styling

| Selector                               | Part                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `.knapsack-block`                      | The whole block                                                                 |
| `.knapsack-form`                       | The inputs and buttons                                                          |
| `.knapsack-field`                      | One field's row, with `data-field` (its name), `data-type`, and `data-required` |
| `.knapsack-missing`                    | A required field left empty                                                     |
| `.knapsack-actions`                    | The row of buttons                                                              |
| `.knapsack-preview`                    | The generated Markdown and any messages                                         |
| `.knapsack-error`, `.knapsack-warning` | Message blocks                                                                  |
| `.knapsack-query`                      | A block with a `query`                                                          |
| `.knapsack-query-filters`              | The buttons that choose which rows are listed; each `.knapsack-query-filter` has `data-status` |
| `.knapsack-query-list`                 | The list of rows; each `.knapsack-query-row` has `data-status`                  |
| `.knapsack-query-current`              | The selected row's note path and the copy button |
| `.knapsack-query-actions`              | The create buttons                                                              |


## Network requests

None.

## Background tasks

None.

## Dependencies

| Library                                                 | Purpose                                         |
| ------------------------------------------------------- | ----------------------------------------------- |
| [knap](https://github.com/obsidianmd/knap)              | Template rendering and syntax highlighting      |
| [monkey-around](https://github.com/pjeby/monkey-around) | Opening `.knap.md` files in the template editor |
| [vaultquery](https://github.com/bobstanton/vaultquery)  | Finding the VaultQuery plugin for the `query` setting |

The `query` setting uses the VaultQuery plugin when it is installed. Knapsack works without it.

The suggestions and delimiter pairing in `src/vendor` are copied from the [Knap playground](https://github.com/obsidianmd/knap/tree/main/website/src/lib).
