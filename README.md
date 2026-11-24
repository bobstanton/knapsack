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
| `list`                   | Several values, separated by commas                         |
| `note`                   | A note, chosen from suggestions; the template gets its name |
| `notes`                  | Several notes, separated by commas                          |
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


## Network requests

None.

## Background tasks

None.

## Dependencies

| Library                                                 | Purpose                                         |
| ------------------------------------------------------- | ----------------------------------------------- |
| [knap](https://github.com/obsidianmd/knap)              | Template rendering and syntax highlighting      |
| [monkey-around](https://github.com/pjeby/monkey-around) | Opening `.knap.md` files in the template editor |

The suggestions and delimiter pairing in `src/vendor` are copied from the [Knap playground](https://github.com/obsidianmd/knap/tree/main/website/src/lib).
