# Control and Learning for Autonomous Robotics (CLeAR) Lab Page

This is the repository for the [CLeAR lab page](https://clearoboticslab.github.io/). The site is based on Jekyll and uses GitHub Pages. The site is based upon the template used by the [Kording Lab](http://kordinglab.com/) at UPenn. Thanks!

## Run the page locally using Jekyll

To run locally, follow instruction [here](https://jekyllrb.com/) to install Jekyll then run `jekyll serve` to see in `localhost:4000`. Here is a brief install guidelines.

```bash
sudo gem install jekyll
sudo gem install rouge
jekyll serve
```

## Editing the lab website

Below, we explain how to edit the lab webpage

### Add posts

It's very easy to add post. All the posts are located in `_posts` folder. It arrangement is based on
date. Each post can be written in markdown format. You just have to state headers before writing: `title`, `description` and `categories`. `description` will be shown when you share on social media like Facebook or twitter. See the following headers:

``` markdown
---
title: <your title here>
description: <concise description here>
categories: blog
---
```

We have 4 categories: `scientists`, `students`, `discussion`, `blog` you can choose and this will be rendered to different location.

### How to add posts

- **Directly edit on Github**, you can simply go to `_posts` and click `New file` then put some markdown file e.g. `2016-02-03-post-name.md` and start writing blog post. Github also allows you to preview it so it's nice for people who don't want to clone the repo.

- **Clone the repository**, kind of the same as directly add post on Github. You just have to clone the repository. Then add new post file, commit and push to the repo. Please make all changes via Pull Request.

The changes will take approximately half a minute to render.

### Add yourself

You can add yourself to the page in `_people` folder just create file name `<firstname>_<lastname>.md` in the folder. We require few line of header before you start writing your own page. See the following for the header

``` markdown
---
name: James Kirk
position: gradstudent
avatar: james_kirk.jpg
joined: 2021
---
```

If you don't have information, just leave it blank. The avatar will bring photo from `images/people` folder and display it on people page.
For lab position, you can choose position from 4 classes including `postdoc`, `gradstudent`, `visiting`, `others` (so called Honorary members). Position will put you into section that you choose.

### Add your publications

Copy the BibTex entry of your paper from Google Scholar and paste it in `_bibliography/references.bib`, after the first 4 lines. Make sure to include PDF and video links as relevant.

### Publish an update

If you're part of the CLeAR lab GitHub organization and you've made a change, reviewed and merged a pull request, you can do the following to publish your updates to the website. This assumes you have a local version of this repository on your PC.

- `git pull` the most recent merged changes locally
- `rake publish` to convert the files in `source` branch to static site in `master branch`. This automatically calls a GitHub _action_ to deploy the contents of `master` branch to https://clearoboticslab.github.io

### Add news

All news presented in the front page by editing `_data/news.yml`. There are some symbol that cannot be used directly e.g. `:`, be careful!
